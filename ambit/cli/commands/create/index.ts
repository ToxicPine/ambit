// =============================================================================
// Create Command - Create Tailscale Subnet Router on Fly.io Custom Network
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, readSecret } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput, type Output } from "@/lib/output.ts";
import { type Machine, runMachine } from "@/lib/machine.ts";
import { registerCommand } from "@/cli/mod.ts";
import { getRouterTag } from "@/util/naming.ts";
import { isPublicTld } from "@/util/guard.ts";
import { createFlyProvider, type FlyProvider } from "@/providers/fly.ts";
import {
  type AclSetResult,
  createTailscaleProvider,
  type TailscaleProvider,
} from "@/providers/tailscale.ts";
import { getCredentialStore } from "@/util/credentials.ts";
import {
  FLY_PRIVATE_SUBNET,
  TAILSCALE_API_KEY_PREFIX,
} from "@/util/constants.ts";
import { resolveOrg } from "@/util/resolve.ts";
import {
  assertAdditivePatch,
  isAutoApproverConfigured,
  isTagOwnerConfigured,
  patchAutoApprover,
  patchTagOwner,
} from "@/util/tailscale-local.ts";
import {
  type CreateCtx,
  type CreatePhase,
  type CreateResult,
  createTransition,
  hydrateCreate,
  reportSkipped,
} from "./machine.ts";

// =============================================================================
// Stage 1: Fly.io Configuration
// =============================================================================

const stageFlyConfig = async (
  out: Output<CreateResult>,
  opts: { json: boolean; org?: string; region?: string },
): Promise<{ fly: FlyProvider; org: string; region: string }> => {
  out.header("Step 1: Fly.io Configuration").blank();

  const fly = createFlyProvider();
  await fly.auth.ensureInstalled();

  const email = await fly.auth.login({ interactive: !opts.json });
  out.ok(`Authenticated as ${email}`);

  const org = await resolveOrg(fly, opts, out);
  const region = opts.region || "iad";
  out.ok(`Using Region: ${region}`);

  out.blank();
  return { fly, org, region };
};

// =============================================================================
// Stage 2: Tailscale Configuration
// =============================================================================

const handleAclSetFailure = (
  out: Output<CreateResult>,
  result: AclSetResult,
  action: string,
): never => {
  if (result.status === 403) {
    out.err(`${action}: Permission Denied (HTTP 403)`);
    return out.die(
      "Your API Token Lacks ACL Write Permission. Re-run with --manual to Skip ACL Changes",
    );
  }
  return out.die(`${action}: ${result.error ?? `HTTP ${result.status}`}`);
};

const stageTailscaleConfig = async (
  out: Output<CreateResult>,
  opts: {
    json: boolean;
    manual: boolean;
    apiKey?: string;
    tag: string;
    network: string;
  },
): Promise<TailscaleProvider> => {
  out.header("Step 2: Tailscale Configuration").blank();

  const credentials = getCredentialStore();
  let apiKey = opts.apiKey || (await credentials.getTailscaleApiKey());

  if (!apiKey) {
    if (opts.json) {
      return out.die("--api-key Is Required in JSON Mode");
    }

    out.dim(
      "Ambit Needs an API Access Token (Not an Auth Key) to Manage Your Tailnet.",
    )
      .dim("Create One at:").link(
        "  https://login.tailscale.com/admin/settings/keys",
      )
      .blank();

    apiKey = await readSecret("API access token (tskey-api-...): ");
    if (!apiKey) {
      return out.die("Tailscale API Access Token Required");
    }
  }

  if (!apiKey.startsWith(TAILSCALE_API_KEY_PREFIX)) {
    return out.die(
      "Invalid Token Format. Expected 'tskey-api-...' (API Access Token, Not Auth Key)",
    );
  }

  const tailscale = createTailscaleProvider(apiKey);

  const validateSpinner = out.spinner("Validating API Access Token");
  const isValid = await tailscale.auth.validateKey();
  if (!isValid) {
    validateSpinner.fail("Invalid API Access Token");
    return out.die("Failed to Validate Tailscale API Access Token");
  }
  validateSpinner.success("API Access Token Validated");

  await credentials.setTailscaleApiKey(apiKey);

  const tagOwnerSpinner = out.spinner(`Checking tagOwners for ${opts.tag}`);
  let policy = await tailscale.acl.getPolicy();
  const hasTagOwner = isTagOwnerConfigured(policy, opts.tag);

  if (!hasTagOwner && !opts.manual && policy) {
    tagOwnerSpinner.stop();
    const beforeTagOwner = policy;
    policy = patchTagOwner(policy, opts.tag);
    assertAdditivePatch(beforeTagOwner, policy);
    const validateTagOwner = await tailscale.acl.validatePolicy(policy);
    if (!validateTagOwner.ok) {
      return handleAclSetFailure(
        out,
        validateTagOwner,
        `Validating tagOwners patch for ${opts.tag}`,
      );
    }
    const patchSpinner = out.spinner(`Adding ${opts.tag} to tagOwners`);
    const result = await tailscale.acl.setPolicy(policy!);
    if (!result.ok) {
      patchSpinner.fail(`Adding ${opts.tag} to tagOwners`);
      return handleAclSetFailure(
        out,
        result,
        `Adding ${opts.tag} to tagOwners`,
      );
    }
    patchSpinner.success(`Added ${opts.tag} to tagOwners`);
  } else if (!hasTagOwner) {
    tagOwnerSpinner.fail(`${opts.tag} Not Set Up Yet`);
    out.blank()
      .text(
        `  You need to grant yourself permission to create the "${opts.network}"`,
      )
      .text(
        `  network by setting up ${opts.tag} in Tailscale.`,
      )
      .blank()
      .text(
        `  You can create the tag and assign it to yourself or a group`,
      )
      .text(
        `  you're a part of in the Tailscale dashboard:`,
      )
      .link("  https://login.tailscale.com/admin/acls/visual/tags")
      .blank()
      .dim("  Or you can do it manually with this JSON config:")
      .dim(`    "tagOwners": { "${opts.tag}": ["autogroup:admin"] }`)
      .blank();
    return out.die(`Set Up ${opts.tag} in Tailscale, Then Try Again`);
  } else {
    tagOwnerSpinner.success(`${opts.tag} Found in Tailscale ACL`);
  }

  if (!opts.manual) {
    const hasApprover = isAutoApproverConfigured(policy, opts.tag);
    if (!hasApprover && policy) {
      const beforeApprover = policy;
      policy = patchAutoApprover(policy, opts.tag, FLY_PRIVATE_SUBNET);
      assertAdditivePatch(beforeApprover, policy);
      const validateApprover = await tailscale.acl.validatePolicy(policy);
      if (!validateApprover.ok) {
        return handleAclSetFailure(
          out,
          validateApprover,
          `Validating autoApprover patch for ${opts.tag}`,
        );
      }
      const approverSpinner = out.spinner(
        `Adding autoApprover for ${opts.tag}`,
      );
      const result = await tailscale.acl.setPolicy(policy!);
      if (!result.ok) {
        approverSpinner.fail(`Adding autoApprover for ${opts.tag}`);
        return handleAclSetFailure(
          out,
          result,
          `Adding autoApprover for ${opts.tag}`,
        );
      }
      approverSpinner.success(`Added autoApprover for ${opts.tag}`);
    }
  } else if (opts.json) {
    const approverSpinner = out.spinner(
      `Checking autoApprovers for ${opts.tag}`,
    );
    const hasApprover = isAutoApproverConfigured(policy, opts.tag);

    if (!hasApprover) {
      approverSpinner.fail(`Auto-approve Not Configured for ${opts.tag}`);
      out.blank()
        .text(
          "  In JSON mode, ambit can't interactively approve the router's",
        )
        .text(
          `  network connections. You can set this up from the Tailscale dashboard:`,
        )
        .link("  https://login.tailscale.com/admin/acls/visual/auto-approvers")
        .dim(`  Route: ${FLY_PRIVATE_SUBNET}  Owner: ${opts.tag}`)
        .blank()
        .dim("  Or you can do it manually with this JSON config:")
        .dim(
          `    "autoApprovers": { "routes": { "${FLY_PRIVATE_SUBNET}": ["${opts.tag}"] } }`,
        )
        .blank();
      return out.die(
        `Set Up Auto-approve for ${opts.tag} to Use --json`,
      );
    }

    approverSpinner.success(`Auto-approve Configured for ${opts.tag}`);
  }

  out.blank();
  return tailscale;
};

// =============================================================================
// Stage 3: Deploy Subnet Router
// =============================================================================

const stageDeploy = async (
  out: Output<CreateResult>,
  fly: FlyProvider,
  tailscale: TailscaleProvider,
  opts: {
    network: string;
    org: string;
    region: string;
    tag: string;
    shouldApprove: boolean;
  },
): Promise<void> => {
  out.header("Step 3: Deploy Subnet Router").blank();

  const ctx: CreateCtx = {
    fly,
    tailscale,
    out,
    ...opts,
    appName: "",
    routerId: "",
  };

  const phase = await hydrateCreate(ctx);

  if (phase === "complete") {
    out.ok(`Network "${opts.network}" Already Fully Created`);
    out.done({
      network: opts.network,
      router: {
        appName: ctx.appName,
        tailscaleIp: ctx.device?.addresses[0] ?? null,
      },
      subnet: ctx.subnet ?? null,
      tag: opts.tag,
    });
    out.print();
    return;
  }

  reportSkipped(out, phase);

  const machine: Machine<CreatePhase, CreateCtx> = {
    terminal: "complete",
    transition: createTransition,
  };

  const result = await runMachine(machine, phase, ctx);
  if (!result.ok) return out.die(result.error!);

  stageSummary(out, fly, tailscale, ctx, opts);
};

// =============================================================================
// Stage 4: Summary
// =============================================================================

const stageSummary = async (
  out: Output<CreateResult>,
  fly: FlyProvider,
  tailscale: TailscaleProvider,
  ctx: CreateCtx,
  opts: { network: string; tag: string; shouldApprove: boolean },
): Promise<void> => {
  const policy = await tailscale.acl.getPolicy();
  const hasAutoApprover = isAutoApproverConfigured(policy, opts.tag);

  out.done({
    network: opts.network,
    router: {
      appName: ctx.appName,
      tailscaleIp: ctx.device?.addresses[0] ?? null,
    },
    subnet: ctx.subnet ?? null,
    tag: opts.tag,
  });

  out.blank()
    .header("=".repeat(50))
    .header("  Router Created!")
    .header("=".repeat(50))
    .blank()
    .text(`The "${opts.network}" Network Is Ready.`)
    .blank()
    .text(`You Can Deploy Apps to It With:`)
    .text(`  npx @cardelli/ambit deploy <app-name>.${opts.network}`)
    .blank();

  out.dim("Invite People to Your Tailnet:")
    .link("  https://login.tailscale.com/admin/users")
    .blank();

  if (ctx.subnet) {
    out.header("Next: Allow Traffic Through the Router")
      .blank()
      .text(
        "  You must configure Tailscale so that traffic can flow from your",
      )
      .text(
        `  devices through the router and into the "${opts.network}" network.`,
      );

    if (!hasAutoApprover) {
      out.blank()
        .text("  1. Automatically Allow Traffic Through the Router:")
        .dim(
          "     Tailscale needs to trust the router's network connections.",
        )
        .blank()
        .dim("     You can do this from the Tailscale dashboard:")
        .link(
          "     https://login.tailscale.com/admin/acls/visual/auto-approvers",
        )
        .dim(`     Route: ${ctx.subnet}  Owner: ${opts.tag}`)
        .blank()
        .dim("     Or you can do it manually with this JSON config:")
        .dim(
          `     "autoApprovers": { "routes": { "${ctx.subnet}": ["${opts.tag}"] } }`,
        );

      if (opts.shouldApprove) {
        out.blank().dim(
          "     Traffic Was Allowed via API for This Session.",
        );
      }
    }

    out.blank()
      .text(
        `  ${
          hasAutoApprover ? "1" : "2"
        }. Control Who Can Reach Apps on This Network:`,
      )
      .dim(
        "     This lets you restrict which users or devices can access your apps.",
      )
      .blank()
      .dim("     You can do this from the Tailscale dashboard:")
      .link(
        "     https://login.tailscale.com/admin/acls/visual/general-access-rules",
      )
      .dim(`     Source: group:YOUR_GROUP    Destination: ${opts.tag}:53`)
      .dim(`     Source: group:YOUR_GROUP    Destination: ${ctx.subnet}:*`)
      .blank()
      .dim("     Or you can do it manually with this JSON config:")
      .dim(
        `     {"action": "accept", "src": ["group:YOUR_GROUP"], "dst": ["${opts.tag}:53"]}`,
      )
      .dim(
        `     {"action": "accept", "src": ["group:YOUR_GROUP"], "dst": ["${ctx.subnet}:*"]}`,
      )
      .blank();
  }

  if (!opts.shouldApprove) {
    out.dim("Route Approval Was Skipped. To Complete Setup:")
      .dim(`  ambit doctor network ${opts.network}`)
      .blank();
  }

  out.print();
};

// =============================================================================
// Create Command
// =============================================================================

const create = async (argv: string[]): Promise<void> => {
  const opts = {
    string: ["org", "region", "api-key", "tag"],
    boolean: ["help", "yes", "json", "no-auto-approve", "manual"],
    alias: { y: "yes" },
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit create");

  if (args.help) {
    console.log(`
${bold("ambit create")} - Create Tailscale Subnet Router

${bold("USAGE")}
  ambit create <network> [options]

${bold("OPTIONS")}
  --org <org>         Fly.io organization slug
  --region <region>   Fly.io region (default: iad)
  --api-key <key>     Tailscale API access token (tskey-api-...)
  --tag <tag>         Tailscale ACL tag for the router (default: tag:ambit-<network>)
  --manual            Skip automatic Tailscale ACL configuration (tagOwners + autoApprovers)
  --no-auto-approve   Skip waiting for router and approving routes
  -y, --yes           Skip confirmation prompts
  --json              Output as JSON (implies --no-auto-approve)

${bold("DESCRIPTION")}
  Deploys a Tailscale subnet router onto a Fly.io custom private network.
  The network name becomes a TLD on your tailnet:

    my-app.${args._[0] || "<network>"} resolves to my-app.flycast

  By default, ambit auto-configures your Tailscale ACL policy (tagOwners
  and autoApprovers). Use --manual if your API token lacks ACL write
  permission or you prefer to manage the policy yourself.

${bold("EXAMPLES")}
  ambit create browsers
  ambit create browsers --org my-org --region sea
  ambit create browsers --manual
`);
    return;
  }

  const out = createOutput<CreateResult>(args.json);

  const networkArg = args._[0];
  if (!networkArg || typeof networkArg !== "string") {
    return out.die("Network Name Required. Usage: ambit create <network>");
  }
  const network = networkArg;
  if (isPublicTld(network)) {
    return out.die(
      `"${network}" Is a Public TLD and Cannot Be Used as a Network Name`,
    );
  }
  const tag = args.tag || getRouterTag(network);
  const manual = !!args.manual;
  const shouldApprove = !manual || !(args["no-auto-approve"] || args.json);

  out.blank()
    .header("=".repeat(50))
    .header(`  ambit Create: ${network}`)
    .header("=".repeat(50))
    .blank();

  const { fly, org, region } = await stageFlyConfig(out, {
    json: args.json,
    org: args.org,
    region: args.region,
  });

  const tailscale = await stageTailscaleConfig(out, {
    json: args.json,
    manual,
    apiKey: args["api-key"],
    tag,
    network,
  });

  await stageDeploy(out, fly, tailscale, {
    network,
    org,
    region,
    tag,
    shouldApprove,
  });
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "create",
  description: "Create a Tailscale subnet router on a Fly.io custom network",
  usage: "ambit create <network> [--org <org>] [--region <region>]",
  run: create,
});
