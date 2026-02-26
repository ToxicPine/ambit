// =============================================================================
// Create Command - Create Tailscale Subnet Router on Fly.io Custom Network
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, randomId, readSecret } from "@/lib/cli.ts";
import { createOutput } from "@/lib/output.ts";
import { registerCommand } from "../mod.ts";
import { extractSubnet, getRouterTag } from "@/src/schemas/config.ts";
import { isPublicTld } from "@/src/guard.ts";
import {
  createFlyProvider,
  FlyDeployError,
  getRouterAppName,
} from "@/src/providers/fly.ts";
import {
  createTailscaleProvider,
  enableAcceptRoutes,
  isAcceptRoutesEnabled,
  isTailscaleInstalled,
  waitForDevice,
} from "@/src/providers/tailscale.ts";
import { getCredentialStore } from "@/src/credentials.ts";
import { resolveOrg } from "@/src/resolve.ts";
import { findRouterApp } from "@/src/discovery.ts";

// =============================================================================
// Create Command
// =============================================================================

const create = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["org", "region", "api-key", "tag"],
    boolean: ["help", "yes", "json", "no-auto-approve"],
    alias: { y: "yes" },
  });

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

  const out = createOutput<{
    network: string;
    router: { appName: string; tailscaleIp: string };
    subnet: string;
    tag: string;
  }>(args.json);

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

  // ==========================================================================
  // Step 1: Fly.io Authentication
  // ==========================================================================

  out.header("Step 1: Fly.io Configuration").blank();

  const fly = createFlyProvider();
  await fly.ensureInstalled();

  const email = await fly.ensureAuth({ interactive: !args.json });
  out.ok(`Authenticated as ${email}`);

  const org = await resolveOrg(fly, args, out);
  const region = args.region || "iad";
  out.ok(`Using Region: ${region}`);

  const existingRouter = await findRouterApp(fly, org, network);
  if (existingRouter) {
    return out.die(
      `A Router Already Exists for Network "${network}": ${existingRouter.appName}. ` +
      `Use "ambit destroy ${network}" First, or Choose a Different Network Name.`
    );
  }

  out.blank();

  // ==========================================================================
  // Step 2: Tailscale Configuration
  // ==========================================================================

  out.header("Step 2: Tailscale Configuration").blank();

  const credentials = getCredentialStore();
  let apiKey = args["api-key"] || (await credentials.getTailscaleApiKey());

  if (!apiKey) {
    if (args.json) {
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

  if (!apiKey.startsWith("tskey-api-")) {
    return out.die(
      "Invalid Token Format. Expected 'tskey-api-...' (API access token, not auth key)",
    );
  }

  const tailscale = createTailscaleProvider("-", apiKey);

  const validateSpinner = out.spinner("Validating API Access Token");

  const isValid = await tailscale.validateApiKey();
  if (!isValid) {
    validateSpinner.fail("Invalid API Access Token");
    return out.die("Failed to Validate Tailscale API Access Token");
  }

  validateSpinner.success("API Access Token Validated");

  await credentials.setTailscaleApiKey(apiKey);

  // ==========================================================================
  // Step 2.5: Check tagOwners
  // ==========================================================================

  const tagOwnerSpinner = out.spinner(`Checking tagOwners for ${tag}`);
  const hasTagOwner = await tailscale.isTagOwnerConfigured(tag);

  if (!hasTagOwner) {
    tagOwnerSpinner.fail(`Tag ${tag} Not Configured in tagOwners`);
    out.blank()
      .text(`  The Tag ${tag} Does Not Exist in Your Tailscale ACL tagOwners.`)
      .text("  Tailscale Will Reject Auth Keys for Undefined Tags.")
      .blank()
      .text("  Add This Tag in Your Tailscale ACL Settings:")
      .dim("  https://login.tailscale.com/admin/acls/visual/tags")
      .blank()
      .dim(`    "tagOwners": { "${tag}": ["autogroup:admin"] }`)
      .blank();
    return out.die(`Add ${tag} to tagOwners Before Creating Router`);
  }

  tagOwnerSpinner.success(`Tag ${tag} Configured in tagOwners`);

  // In JSON mode (no interactive approval), autoApprovers must be configured
  // so routes are approved automatically when the router advertises them.
  if (args.json) {
    const approverSpinner = out.spinner(`Checking autoApprovers for ${tag}`);
    const hasApprover = await tailscale.isAutoApproverConfigured(tag);

    if (!hasApprover) {
      approverSpinner.fail(`autoApprovers Not Configured for ${tag}`);
      out.blank()
        .text("  JSON mode skips interactive route approval.")
        .text(`  Configure autoApprovers for ${tag} so routes are approved on deploy.`)
        .blank()
        .dim("  Add to your ACL at: https://login.tailscale.com/admin/acls/file")
        .blank()
        .dim(`    "autoApprovers": { "routes": { "fdaa::/16": ["${tag}"] } }`)
        .blank();
      return out.die(`Configure autoApprovers for ${tag} Before Using --json`);
    }

    approverSpinner.success(`autoApprovers Configured for ${tag}`);
  }

  out.blank();

  // ==========================================================================
  // Step 3: Deploy Router on Custom 6PN
  // ==========================================================================

  let hasAutoApprover = false;

  out.header("Step 3: Deploy Subnet Router").blank();

  const suffix = randomId(8);
  const routerAppName = getRouterAppName(network, suffix);
  out.info(`Creating Router App: ${routerAppName}`)
    .info(`Custom Network: ${network}`)
    .info(`Router Tag: ${tag}`);

  await fly.createApp(routerAppName, org, { network });
  out.ok(`Created App: ${routerAppName}`);

  const authKeySpinner = out.spinner("Creating Tag-Scoped Auth Key");
  const authKey = await tailscale.createAuthKey({
    reusable: false,
    ephemeral: false,
    preauthorized: true,
    tags: [tag],
  });
  authKeySpinner.success("Auth Key Created (Single-Use, 5min Expiry)");

  await fly.setSecrets(routerAppName, {
    TAILSCALE_AUTHKEY: authKey,
    NETWORK_NAME: network,
    ROUTER_ID: suffix,
  }, { stage: true });
  out.ok("Set Router Secrets");

  const dockerDir = new URL("../../docker/router", import.meta.url).pathname;

  out.blank().dim("Deploying Router...");

  try {
    await fly.routerDeploy(routerAppName, dockerDir, { region });
  } catch (e) {
    if (e instanceof FlyDeployError) {
      out.dim(`  ${e.detail}`);
      return out.die(e.message);
    }
    throw e;
  }
  out.ok("Router Deployed");

  // ==========================================================================
  // Step 4: Wait for Router, Approve Routes, Configure DNS
  // ==========================================================================

  let device: Awaited<ReturnType<typeof waitForDevice>> | null = null;
  let routerMachine: { private_ip?: string; state?: string } | undefined;
  let subnet: string | null = null;

  if (shouldApprove) {
    out.blank();
    const joinSpinner = out.spinner("Waiting for Router to Join Tailnet");

    device = await waitForDevice(tailscale, routerAppName, 180000);

    joinSpinner.success(`Router Joined Tailnet: ${device.addresses[0]}`);

    const machines = await fly.listMachines(routerAppName);
    routerMachine = machines.find((m) => m.private_ip);
    subnet = routerMachine?.private_ip
      ? extractSubnet(routerMachine.private_ip)
      : null;

    if (subnet) {
      out.ok(`Subnet: ${subnet}`);

      hasAutoApprover = await tailscale.isAutoApproverConfigured(tag);
      if (!hasAutoApprover) {
        const approveSpinner = out.spinner("Approving Subnet Routes");
        await tailscale.approveSubnetRoutes(device.id, [subnet]);
        approveSpinner.success("Subnet Routes Approved");
      } else {
        out.ok("Routes Auto-Approved via ACL Policy");
      }
    }

    if (device.advertisedRoutes && device.advertisedRoutes.length > 0) {
      out.ok(`Routes: ${device.advertisedRoutes.join(", ")}`);
    }

    const dnsSpinner = out.spinner("Configuring Split DNS");

    await tailscale.setSplitDns(network, [device.addresses[0]]);

    dnsSpinner.success(`Split DNS Configured: *.${network} -> Router`);

    // ========================================================================
    // Step 5: Local Client Configuration
    // ========================================================================

    out.blank().header("Step 5: Local Client Configuration").blank();

    if (await isTailscaleInstalled()) {
      if (await isAcceptRoutesEnabled()) {
        out.ok("Accept Routes Already Enabled");
      } else {
        const routeSpinner = out.spinner("Enabling Accept Routes");

        if (await enableAcceptRoutes()) {
          routeSpinner.success("Accept Routes Enabled");
        } else {
          routeSpinner.fail("Could Not Enable Accept Routes");
          out.blank()
            .dim("Run Manually With Elevated Permissions:")
            .dim("  sudo tailscale set --accept-routes");
        }
      }
    } else {
      out.warn("Tailscale CLI Not Found")
        .dim("  Ensure Accept-Routes is Enabled on This Device");
    }
  } else {
    out.blank().info(
      "Skipping Route Approval and DNS Configuration (Use ambit doctor to Verify Later)",
    );
  }

  // ==========================================================================
  // Done
  // ==========================================================================

  out.done({
    network,
    router: {
      appName: routerAppName,
      tailscaleIp: device?.addresses[0] ?? "pending",
    },
    subnet: subnet || "pending",
    tag,
  });

  out.blank()
    .header("=".repeat(50))
    .header("  Router Created!")
    .header("=".repeat(50))
    .blank()
    .text(`Any Flycast app on the "${network}" network is reachable as:`)
    .text(`  <app-name>.${network}`)
    .blank();

  if (routerMachine?.private_ip) {
    out.text("SOCKS5 Proxy Available at:")
      .text(`  socks5://[${routerMachine.private_ip}]:1080`)
      .dim("Containers on This Network Can Use It to Reach Your Tailnet.")
      .blank();
  }

  out.dim("Deploy an App to This Network:")
    .dim(`  ambit deploy my-app --network ${network}`)
    .blank()
    .dim("Invite People to Your Tailnet:")
    .dim("  https://login.tailscale.com/admin/users")
    .dim("Control Their Access:")
    .dim("  https://login.tailscale.com/admin/acls/visual/general-access-rules")
    .blank();

  if (subnet && !hasAutoApprover) {
    out.header("Recommended: Configure autoApprovers")
      .blank()
      .dim("  Add to Your Tailnet Policy File at:")
      .dim("  https://login.tailscale.com/admin/acls/file")
      .blank()
      .text(`  "autoApprovers": { "routes": { "${subnet}": ["${tag}"] } }`)
      .blank()
      .dim("  Routes Were Approved via API for This Session.")
      .dim("  autoApprovers Will Auto-Approve on Future Restarts.")
      .blank();
  }

  if (subnet) {
    out.header("Recommended ACL Rules:")
      .blank()
      .dim("  To Restrict Access, Add ACL Rules to Your Policy File:")
      .dim("  https://login.tailscale.com/admin/acls/file")
      .blank()
      .dim(
        `    {"action": "accept", "src": ["group:YOUR_GROUP"], "dst": ["${tag}:53"]}`,
      )
      .dim(
        `    {"action": "accept", "src": ["group:YOUR_GROUP"], "dst": ["${subnet}:*"]}`,
      )
      .blank();
  }

  if (!shouldApprove) {
    out.dim("Route Approval Was Skipped. To Complete Setup:")
      .dim(`  ambit doctor --network ${network}`)
      .blank();
  }

  out.print();
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
