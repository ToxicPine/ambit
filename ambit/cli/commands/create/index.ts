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
import {
  createFlyProvider,
  type FlyProvider,
} from "@/providers/fly.ts";
import {
  createTailscaleProvider,
  type TailscaleProvider,
} from "@/providers/tailscale.ts";
import { getCredentialStore } from "@/util/credentials.ts";
import {
  FLY_PRIVATE_SUBNET,
  SOCKS_PROXY_PORT,
  TAILSCALE_API_KEY_PREFIX,
} from "@/util/constants.ts";
import { resolveOrg } from "@/util/resolve.ts";
import { isAutoApproverConfigured, isTagOwnerConfigured } from "@/util/tailscale-local.ts";
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

const stageTailscaleConfig = async (
  out: Output<CreateResult>,
  opts: { json: boolean; apiKey?: string; tag: string; network: string },
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
      .dim("Create One at: https://login.tailscale.com/admin/settings/keys")
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
  const policy = await tailscale.acl.getPolicy();
  const hasTagOwner = isTagOwnerConfigured(policy, opts.tag);

  if (!hasTagOwner) {
    tagOwnerSpinner.fail(`Tag ${opts.tag} Not Configured in tagOwners`);
    out.blank()
      .text(
        `  The Tag ${opts.tag} Does Not Exist in Your Tailscale ACL tagOwners.`,
      )
      .text("  Tailscale Will Reject Auth Keys for Undefined Tags.")
      .blank()
      .text("  Add This Tag in Your Tailscale ACL Settings:")
      .dim("  https://login.tailscale.com/admin/acls/visual/tags")
      .blank()
      .dim(`    "tagOwners": { "${opts.tag}": ["autogroup:admin"] }`)
      .blank();
    return out.die(`Add ${opts.tag} to tagOwners Before Creating Router`);
  }

  tagOwnerSpinner.success(`Tag ${opts.tag} Configured in tagOwners`);

  if (opts.json) {
    const approverSpinner = out.spinner(
      `Checking autoApprovers for ${opts.tag}`,
    );
    const hasApprover = isAutoApproverConfigured(policy, opts.tag);

    if (!hasApprover) {
      approverSpinner.fail(`autoApprovers Not Configured for ${opts.tag}`);
      out.blank()
        .text("  JSON mode skips interactive route approval.")
        .text(
          `  Configure autoApprovers for ${opts.tag} so routes are approved on deploy.`,
        )
        .blank()
        .dim(
          "  Add to your ACL at: https://login.tailscale.com/admin/acls/file",
        )
        .blank()
        .dim(
          `    "autoApprovers": { "routes": { "${FLY_PRIVATE_SUBNET}": ["${opts.tag}"] } }`,
        )
        .blank();
      return out.die(
        `Configure autoApprovers for ${opts.tag} Before Using --json`,
      );
    }

    approverSpinner.success(`autoApprovers Configured for ${opts.tag}`);
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
    .text(`Any Flycast App on the "${opts.network}" Network Is Reachable as:`)
    .text(`  <app-name>.${opts.network}`)
    .blank();

  if (ctx.subnet) {
    const machines = await fly.machines.list(ctx.appName);
    const routerMachine = machines.find((m) => m.private_ip);
    if (routerMachine?.private_ip) {
      out.text("SOCKS5 Proxy Available at:")
        .text(`  socks5://[${routerMachine.private_ip}]:${SOCKS_PROXY_PORT}`)
        .dim("Containers on This Network Can Use It to Reach Your Tailnet.")
        .blank();
    }
  }

  out.dim("Deploy an App to This Network:")
    .dim(`  ambit deploy my-app --network ${opts.network}`)
    .blank()
    .dim("Invite People to Your Tailnet:")
    .dim("  https://login.tailscale.com/admin/users")
    .dim("Control Their Access:")
    .dim(
      "  https://login.tailscale.com/admin/acls/visual/general-access-rules",
    )
    .blank();

  if (ctx.subnet && !hasAutoApprover) {
    out.header("Recommended: Configure autoApprovers")
      .blank()
      .dim("  Add to Your Tailnet Policy File at:")
      .dim("  https://login.tailscale.com/admin/acls/file")
      .blank()
      .text(
        `  "autoApprovers": { "routes": { "${ctx.subnet}": ["${opts.tag}"] } }`,
      )
      .blank()
      .dim("  Routes Were Approved via API for This Session.")
      .dim("  autoApprovers Will Auto-Approve on Future Restarts.")
      .blank();
  }

  if (ctx.subnet) {
    out.header("Recommended ACL Rules:")
      .blank()
      .dim("  To Restrict Access, Add ACL Rules to Your Policy File:")
      .dim("  https://login.tailscale.com/admin/acls/file")
      .blank()
      .dim(
        `    {"action": "accept", "src": ["group:YOUR_GROUP"], "dst": ["${opts.tag}:53"]}`,
      )
      .dim(
        `    {"action": "accept", "src": ["group:YOUR_GROUP"], "dst": ["${ctx.subnet}:*"]}`,
      )
      .blank();
  }

  if (!opts.shouldApprove) {
    out.dim("Route Approval Was Skipped. To Complete Setup:")
      .dim(`  ambit doctor --network ${opts.network}`)
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
    boolean: ["help", "yes", "json", "no-auto-approve"],
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
  --no-auto-approve        Skip waiting for router and approving routes
  -y, --yes           Skip confirmation prompts
  --json              Output as JSON (implies --no-auto-approve)

${bold("DESCRIPTION")}
  Deploys a Tailscale subnet router onto a Fly.io custom private network.
  The network name becomes a TLD on your tailnet:

    my-app.${args._[0] || "<network>"} resolves to my-app.flycast

${bold("EXAMPLES")}
  ambit create browsers
  ambit create browsers --org my-org --region sea
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
  const shouldApprove = !(args["no-auto-approve"] || args.json);

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
