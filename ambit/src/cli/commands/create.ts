// =============================================================================
// Create Command - Create Tailscale Subnet Router on Fly.io Custom Network
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, randomId, readSecret } from "../../../lib/cli.ts";
import { createOutput } from "../../../lib/output.ts";
import { registerCommand } from "../mod.ts";
import { extractSubnet, getRouterTag } from "../../schemas/config.ts";
import { createFlyProvider, getRouterAppName } from "../../providers/fly.ts";
import {
  createTailscaleProvider,
  enableAcceptRoutes,
  isAcceptRoutesEnabled,
  isTailscaleInstalled,
  waitForDevice,
} from "../../providers/tailscale.ts";
import { getCredentialStore } from "../../credentials.ts";
import { resolveOrg } from "../../resolve.ts";

// =============================================================================
// Create Command
// =============================================================================

const create = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["org", "region", "api-key", "tag"],
    boolean: ["help", "yes", "json", "self-approve"],
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
  --self-approve      Approve subnet routes via API (when autoApprovers not configured)
  -y, --yes           Skip confirmation prompts
  --json              Output as JSON

${bold("DESCRIPTION")}
  Deploys a Tailscale subnet router onto a Fly.io custom private network.
  The network name becomes a TLD on your tailnet:

    my-app.${args._[0] || "<network>"} resolves to my-app.flycast

${bold("EXAMPLES")}
  ambit create browsers
  ambit create browsers --org my-org --region sea
  ambit create browsers --self-approve
`);
    return;
  }

  const out = createOutput<{
    network: string;
    router: { appName: string; tailscaleIp: string };
    subnet: string;
    tag: string;
  }>(args.json);

  const network = args._[0] as string | undefined;
  if (!network) {
    return out.die("Network Name Required. Usage: ambit create <network>");
  }
  const tag = args.tag || getRouterTag(network);
  const selfApprove = args["self-approve"] ?? false;

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
  out.ok(`Using Region: ${region}`).blank();

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
      "ambit needs an API access token (not an auth key) to manage your tailnet.",
    )
      .dim("Create one at: https://login.tailscale.com/admin/settings/keys")
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
      .text(`  The tag ${tag} does not exist in your Tailscale ACL tagOwners.`)
      .text("  Tailscale will reject auth keys for undefined tags.")
      .blank()
      .text("  Add this tag in your Tailscale ACL settings:")
      .dim("  https://login.tailscale.com/admin/acls/visual/tags")
      .blank()
      .dim(`    "tagOwners": { "${tag}": ["autogroup:admin"] }`)
      .blank();
    return out.die(`Add ${tag} to tagOwners Before Creating Router`);
  }

  tagOwnerSpinner.success(`Tag ${tag} Configured in tagOwners`);

  // ==========================================================================
  // Step 2.6: Check autoApprovers
  // ==========================================================================

  if (!selfApprove) {
    const autoApproverSpinner = out.spinner(
      "Checking autoApprovers Configuration",
    );
    const hasAutoApprover = await tailscale.isAutoApproverConfigured(tag);

    if (!hasAutoApprover) {
      autoApproverSpinner.fail("autoApprovers Not Configured");
      out.blank()
        .text(
          `  The tag ${tag} is not listed in your Tailscale ACL autoApprovers.`,
        )
        .text("  Routes advertised by the router will not be auto-approved.")
        .blank()
        .text("  Either configure autoApprovers in your Tailscale ACL policy:")
        .dim(
          `    "autoApprovers": { "routes": { "fdaa:X:XXXX::/48": ["${tag}"] } }`,
        )
        .blank()
        .text("  Or re-run with --self-approve to approve routes via API:")
        .dim(`    ambit create ${network} --self-approve`)
        .blank();
      return out.die("Configure autoApprovers or Use --self-approve");
    }

    autoApproverSpinner.success("autoApprovers Configured");
  } else {
    out.info("Self-Approve Mode: Routes Will Be Approved via API");
  }

  out.blank();

  // ==========================================================================
  // Step 3: Deploy Router on Custom 6PN
  // ==========================================================================

  out.header("Step 3: Deploy Subnet Router").blank();

  const routerAppName = getRouterAppName(network, randomId(6));
  out.info(`Creating Router App: ${routerAppName}`)
    .info(`Custom Network: ${network}`)
    .info(`Router Tag: ${tag}`);

  await fly.createApp(routerAppName, org, { network });
  out.ok(`Created App: ${routerAppName}`);

  await fly.setSecrets(routerAppName, {
    TAILSCALE_API_TOKEN: apiKey,
    NETWORK_NAME: network,
    TAILSCALE_TAGS: tag,
  }, { stage: true });
  out.ok("Set Router Secrets");

  const dockerDir = new URL("../../docker/router", import.meta.url).pathname;

  out.blank().dim("Deploying Router...");

  await fly.routerDeploy(routerAppName, dockerDir, { region });
  out.ok("Router Deployed");

  out.blank();
  const joinSpinner = out.spinner("Waiting for Router to Join Tailnet");

  const device = await waitForDevice(tailscale, routerAppName, 180000);

  joinSpinner.success(`Router Joined Tailnet: ${device.addresses[0]}`);

  const machines = await fly.listMachines(routerAppName);
  const routerMachine = machines.find((m) => m.private_ip);
  const subnet = routerMachine?.private_ip
    ? extractSubnet(routerMachine.private_ip)
    : null;

  if (subnet) {
    out.ok(`Subnet: ${subnet}`);
  }

  if (selfApprove && subnet) {
    const approveSpinner = out.spinner("Approving Subnet Routes via API");
    await tailscale.approveSubnetRoutes(device.id, [subnet]);
    approveSpinner.success("Subnet Routes Approved via API");
  }

  if (device.advertisedRoutes && device.advertisedRoutes.length > 0) {
    out.ok(`Routes: ${device.advertisedRoutes.join(", ")}`);
  }

  const dnsSpinner = out.spinner("Configuring Split DNS");

  await tailscale.setSplitDns(network, [device.addresses[0]]);

  dnsSpinner.success(`Split DNS Configured: *.${network} -> Router`);

  // ==========================================================================
  // Step 4: Local Client Configuration
  // ==========================================================================

  out.blank().header("Step 4: Local Client Configuration").blank();

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
          .dim("Run Manually with Elevated Permissions:")
          .dim("  sudo tailscale set --accept-routes");
      }
    }
  } else {
    out.warn("Tailscale CLI Not Found")
      .dim("  Ensure Accept-Routes Is Enabled on This Device");
  }

  // ==========================================================================
  // Done
  // ==========================================================================

  out.done({
    network,
    router: { appName: routerAppName, tailscaleIp: device.addresses[0] },
    subnet: subnet || "unknown",
    tag,
  });

  out.blank()
    .header("=".repeat(50))
    .header("  Router Created!")
    .header("=".repeat(50))
    .blank()
    .text(`Any Flycast app on the "${network}" network is reachable as:`)
    .text(`  <app-name>.${network}`)
    .blank()
    .text(`SOCKS5 proxy available at:`)
    .text(`  socks5://[${routerMachine?.private_ip ?? "ROUTER_IP"}]:1080`)
    .dim("Containers on this network can use it to reach your tailnet.")
    .blank()
    .dim("Deploy an app to this network:")
    .dim(`  ambit deploy my-app --network ${network}`)
    .blank()
    .dim("Invite people to your tailnet:")
    .dim("  https://login.tailscale.com/admin/users")
    .dim("Control their access:")
    .dim("  https://login.tailscale.com/admin/acls/visual/general-access-rules")
    .blank();

  // Print recommended ACL policy
  if (subnet && selfApprove) {
    out.header("Recommended Tailscale ACL Policy:")
      .blank()
      .dim("  Add these to your tailnet policy file at:")
      .dim("  https://login.tailscale.com/admin/acls/file")
      .blank()
      .text(`  "tagOwners": { "${tag}": ["autogroup:admin"] }`)
      .text(`  "autoApprovers": { "routes": { "${subnet}": ["${tag}"] } }`)
      .blank()
      .dim("  To restrict access, add ACL rules:")
      .dim(
        `    {"action": "accept", "src": ["group:YOUR_GROUP"], "dst": ["${tag}:53"]}`,
      )
      .dim(
        `    {"action": "accept", "src": ["group:YOUR_GROUP"], "dst": ["${subnet}:*"]}`,
      )
      .blank();
  } else if (subnet) {
    out.header("Recommended ACL Rules:")
      .blank()
      .dim("  To restrict access, add ACL rules to your policy file:")
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
