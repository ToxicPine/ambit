// =============================================================================
// Share Command - Grant Members Access to a Network via Tailscale ACL
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput, type Output } from "@/lib/output.ts";
import { registerCommand } from "@/cli/mod.ts";
import { z } from "zod";
import {
  type AclSetResult,
  type TailscaleProvider,
} from "@/providers/tailscale.ts";
import type { FlyProvider } from "@/providers/fly.ts";
import { findRouterApp, getRouterMachineInfo } from "@/util/discovery.ts";
import { getRouterTag } from "@/util/naming.ts";
import {
  assertAdditivePatch,
  isAclRuleConfigured,
  patchAclRule,
} from "@/util/tailscale-local.ts";
import { initSession } from "@/util/session.ts";

// =============================================================================
// Types
// =============================================================================

type ShareResult = {
  network: string;
  members: Member[];
  tag: string;
  subnet: string;
  rulesAdded: number;
};

interface ShareCtx {
  fly: FlyProvider;
  tailscale: TailscaleProvider;
  out: Output<ShareResult>;
  network: string;
  org: string;
  members: Member[];
  json: boolean;
  appName?: string;
  tag?: string;
  subnet?: string;
  rulesAdded: number;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Valid members: Tailscale group/tag/autogroup prefixes, or a plain email.
 */
const MemberSchema = z.union([
  z.string().startsWith("group:").min(7, 'Must be in the form "group:<name>"'),
  z.string().startsWith("tag:").min(5, 'Must be in the form "tag:<name>"'),
  z.string().startsWith("autogroup:").min(
    11,
    'Must be in the form "autogroup:<name>"',
  ),
  z.email(),
]);

type Member = z.infer<typeof MemberSchema>;

const parseMembers = (
  raw: (string | number)[],
): { members: Member[]; errors: string[] } => {
  const members: Member[] = [];
  const errors: string[] = [];

  for (const entry of raw) {
    const result = MemberSchema.safeParse(String(entry));
    if (result.success) {
      members.push(result.data);
    } else {
      errors.push(
        `  '${entry}' — Must Be a Group ("group:team"), Tag ("tag:router"), Autogroup ("autogroup:member"), or Email`,
      );
    }
  }

  return { members, errors };
};

// =============================================================================
// ACL Error Helper
// =============================================================================

const handleAclSetFailure = (
  out: Output<ShareResult>,
  result: AclSetResult,
  action: string,
): never => {
  if (result.status === 403) {
    out.err(`${action}: Permission Denied (HTTP 403)`);
    return out.die(
      "Your API Token Lacks ACL Write Permission (policy_file scope required)",
    );
  }
  return out.die(`${action}: ${result.error ?? `HTTP ${result.status}`}`);
};

// =============================================================================
// Stage 1: Discover Router
// =============================================================================

const stageDiscover = async (ctx: ShareCtx): Promise<void> => {
  ctx.out.header("Step 1: Discover Router").blank();

  const routerSpinner = ctx.out.spinner(
    `Looking Up Router for '${ctx.network}'`,
  );
  const router = await findRouterApp(ctx.fly, ctx.org, ctx.network);
  if (!router) {
    routerSpinner.fail(`No Router Found for '${ctx.network}'`);
    return ctx.out.die(
      `No Router Found for Network '${ctx.network}'. Create It with: ambit create ${ctx.network}`,
    );
  }
  ctx.appName = router.appName;
  routerSpinner.success(`Found Router: ${router.appName}`);

  const machineSpinner = ctx.out.spinner("Getting Subnet");
  const machine = await getRouterMachineInfo(ctx.fly, router.appName);
  if (!machine?.subnet) {
    machineSpinner.fail("No Subnet Found");
    return ctx.out.die(
      `Router Has No Subnet Yet. Ensure the Router Is Running: ambit status network ${ctx.network}`,
    );
  }
  ctx.subnet = machine.subnet;
  machineSpinner.success(`Subnet: ${machine.subnet}`);

  const device = await ctx.tailscale.devices.getByHostname(router.appName);
  ctx.tag = device?.tags?.[0] ?? getRouterTag(ctx.network);
  ctx.out.ok(`Tag: ${ctx.tag}`);
  ctx.out.blank();
};

// =============================================================================
// Stage 2: Update ACL Policy
// =============================================================================

const stageUpdateAcl = async (ctx: ShareCtx): Promise<void> => {
  ctx.out.header("Step 2: Update ACL Policy").blank();

  const policy = await ctx.tailscale.acl.getPolicy();
  if (!policy) {
    return ctx.out.die("Could Not Read Tailscale ACL Policy");
  }

  const dnsDst = `${ctx.tag}:53`;
  const subnetDst = `${ctx.subnet}:*`;

  let updated = policy;

  for (const member of ctx.members) {
    const hasDns = isAclRuleConfigured(updated, member, dnsDst);
    const hasSubnet = isAclRuleConfigured(updated, member, subnetDst);

    if (hasDns && hasSubnet) {
      ctx.out.skip(`${member} — Already Has Full Access`);
      continue;
    }

    if (hasDns) {
      ctx.out.skip(`${member} — DNS Rule Already Present`);
    } else {
      updated = patchAclRule(updated, member, dnsDst);
      ctx.rulesAdded++;
    }

    if (hasSubnet) {
      ctx.out.skip(`${member} — Subnet Rule Already Present`);
    } else {
      updated = patchAclRule(updated, member, subnetDst);
      ctx.rulesAdded++;
    }
  }

  if (ctx.rulesAdded === 0) {
    ctx.out.blank().ok(
      `All Members Already Have Full Access to '${ctx.network}'`,
    );
    return;
  }

  assertAdditivePatch(policy, updated);

  const validateSpinner = ctx.out.spinner("Validating Policy");
  const validateResult = await ctx.tailscale.acl.validatePolicy(updated);
  if (!validateResult.ok) {
    validateSpinner.fail("Policy Validation Failed");
    return handleAclSetFailure(
      ctx.out,
      validateResult,
      "Validating ACL Policy",
    );
  }
  validateSpinner.success("Policy Valid");

  const n = ctx.rulesAdded;
  const patchSpinner = ctx.out.spinner(
    `Updating ACL Policy (${n} new rule${n !== 1 ? "s" : ""})`,
  );
  const result = await ctx.tailscale.acl.setPolicy(updated);
  if (!result.ok) {
    patchSpinner.fail("Failed to Update ACL Policy");
    return handleAclSetFailure(ctx.out, result, "Updating ACL Policy");
  }
  patchSpinner.success(
    `ACL Policy Updated (${n} rule${n !== 1 ? "s" : ""} added)`,
  );
};

// =============================================================================
// Stage 3: Summary
// =============================================================================

const stageSummary = (ctx: ShareCtx): void => {
  const { out, network, members, tag, subnet, rulesAdded } = ctx;

  out.done({ network, members, tag: tag!, subnet: subnet!, rulesAdded });

  if (rulesAdded === 0) {
    out.blank();
    out.print();
    return;
  }

  out.blank()
    .header("=".repeat(50))
    .header("  Access Granted!")
    .header("=".repeat(50))
    .blank();

  for (const member of members) {
    out.ok(`${member}`);
  }

  out.blank()
    .dim(`  DNS:    → ${tag}:53`)
    .dim(`  Subnet: → ${subnet}:*`)
    .blank()
    .dim("Invite People to Your Tailnet:")
    .link("  https://login.tailscale.com/admin/users")
    .blank()
    .dim("To Fine-Tune Which Apps They Can Reach:")
    .link(
      "  https://login.tailscale.com/admin/acls/visual/general-access-rules",
    )
    .blank();

  out.print();
};

// =============================================================================
// Share Command
// =============================================================================

const share = async (argv: string[]): Promise<void> => {
  const opts = {
    string: ["org"],
    boolean: ["help", "json"],
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit share");

  if (args.help) {
    console.log(`
${bold("ambit share")} - Grant Members Access to a Network

${bold("USAGE")}
  ambit share <network> <member> [<member>...] [options]

${bold("MEMBER TYPES")}
  group:<name>          A Tailscale group      (e.g. group:team)
  tag:<name>            A device tag           (e.g. tag:router)
  autogroup:<name>      A built-in group       (e.g. autogroup:member)
  <email>               A Tailscale user       (e.g. alice@example.com)

${bold("OPTIONS")}
  --org <org>           Fly.io organization slug
  --json                Output as JSON

${bold("DESCRIPTION")}
  Grants access to a network by updating your Tailscale ACL policy.
  For each member, ambit adds two rules:
    1. DNS:    <member> → <tag>:53     (resolve *.${
      args._[0] || "<network>"
    } names)
    2. Subnet: <member> → <subnet>:*   (reach apps on the network)

  The command is idempotent — re-running it is safe.

${bold("EXAMPLES")}
  ambit share browsers group:team
  ambit share browsers group:team alice@example.com group:contractors
  ambit share browsers group:team --org my-org
`);
    return;
  }

  const out = createOutput<ShareResult>(args.json);

  const networkArg = args._[0];
  if (!networkArg || typeof networkArg !== "string") {
    return out.die(
      "Network Name Required. Usage: ambit share <network> <member> [...]",
    );
  }

  const rawMembers = args._.slice(1);
  if (rawMembers.length === 0) {
    return out.die(
      "At Least One Member Required. Usage: ambit share <network> <member> [...]",
    );
  }

  const { members, errors } = parseMembers(rawMembers);
  if (errors.length > 0) {
    for (const err of errors) out.err(err);
    return out.die(
      `Invalid Member${
        errors.length > 1 ? "s" : ""
      }: Must Be "group:<name>", "tag:<name>", "autogroup:<name>", or a Valid Email`,
    );
  }

  out.blank()
    .header("=".repeat(50))
    .header(`  ambit Share: ${networkArg}`)
    .header("=".repeat(50))
    .blank();

  const { fly, tailscale, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  const ctx: ShareCtx = {
    fly,
    tailscale,
    out,
    network: networkArg,
    org,
    members,
    json: args.json,
    rulesAdded: 0,
  };

  await stageDiscover(ctx);
  await stageUpdateAcl(ctx);
  stageSummary(ctx);
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "share",
  description: "Grant members access to a network via Tailscale ACL rules",
  usage: "ambit share <network> <member> [<member>...]",
  run: share,
});
