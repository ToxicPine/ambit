// =============================================================================
// Destroy Command - Destroy Networks or Apps
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, confirm } from "@/lib/cli.ts";
import { createOutput } from "@/lib/output.ts";
import { registerCommand } from "../mod.ts";
import { createFlyProvider } from "@/src/providers/fly.ts";
import { createTailscaleProvider } from "@/src/providers/tailscale.ts";
import { checkDependencies } from "@/src/credentials.ts";
import {
  findRouterApp,
  findWorkloadApp,
  listWorkloadAppsOnNetwork,
} from "@/src/discovery.ts";
import { resolveOrg } from "@/src/resolve.ts";
import { assertNotRouter } from "@/src/guard.ts";

// =============================================================================
// Top-Level Help
// =============================================================================

const showDestroyHelp = (): void => {
  console.log(`
${bold("ambit destroy")} - Destroy Networks or Apps

${bold("USAGE")}
  ambit destroy network <name> [options]
  ambit destroy app <app>.<network> [options]

${bold("SUBCOMMANDS")}
  network    Tear down a router, clean up DNS and tailnet device
  app        Destroy a workload app on a network

${bold("OPTIONS")}
  --help     Show help for a subcommand

${bold("EXAMPLES")}
  ambit destroy network browsers
  ambit destroy app my-app.browsers
  ambit destroy app my-app --network browsers

Run 'ambit destroy network --help' or 'ambit destroy app --help' for details.
`);
};

// =============================================================================
// Destroy Network
// =============================================================================

const destroyNetwork = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["network", "org"],
    boolean: ["help", "yes", "json"],
    alias: { y: "yes" },
  });

  if (args.help) {
    console.log(`
${bold("ambit destroy network")} - Tear Down Router

${bold("USAGE")}
  ambit destroy network <name> [--org <org>] [--yes] [--json]

${bold("OPTIONS")}
  --org <org>        Fly.io organization slug
  -y, --yes          Skip confirmation prompts
  --json             Output as JSON

${bold("EXAMPLES")}
  ambit destroy network browsers
  ambit destroy network browsers --org my-org --yes
`);
    return;
  }

  const out = createOutput<{
    destroyed: boolean;
    appName: string;
    workloadAppsWarned: number;
  }>(args.json);

  // Accept network as positional or --network flag (backward compat)
  const network =
    (typeof args._[0] === "string" ? args._[0] : undefined) || args.network;

  if (!network) {
    return out.die(
      "Network name required. Usage: ambit destroy network <name>",
    );
  }

  // ===========================================================================
  // Prerequisites
  // ===========================================================================

  const { tailscaleKey } = await checkDependencies(out);

  const fly = createFlyProvider();
  await fly.ensureAuth({ interactive: !args.json });
  const tailscale = createTailscaleProvider("-", tailscaleKey);
  const org = await resolveOrg(fly, args, out);

  // ===========================================================================
  // Discover Router
  // ===========================================================================

  const spinner = out.spinner("Discovering Router");
  const app = await findRouterApp(fly, org, network);

  if (!app) {
    spinner.fail("Router Not Found");
    return out.die(`No Router Found for Network '${network}'`);
  }

  spinner.success(`Found Router: ${app.appName}`);

  let tsDevice: Awaited<ReturnType<typeof tailscale.getDeviceByHostname>> =
    null;
  try {
    tsDevice = await tailscale.getDeviceByHostname(app.appName);
  } catch {
    /* device may not exist */
  }
  const tag = tsDevice?.tags?.[0] ?? null;

  // ===========================================================================
  // Check for Workload Apps on This Network
  // ===========================================================================

  const workloadApps = await listWorkloadAppsOnNetwork(fly, org, network);

  // ===========================================================================
  // Confirm
  // ===========================================================================

  out.blank()
    .header("ambit Destroy Network")
    .blank()
    .text(`  Network:    ${network}`)
    .text(`  Router App: ${app.appName}`)
    .text(`  Tag:        ${tag ?? "unknown"}`)
    .blank();

  if (workloadApps.length > 0) {
    out.warn(
      `${workloadApps.length} Workload App(s) Still on Network '${network}':`,
    );
    for (const wa of workloadApps) {
      out.text(`  - ${wa.appName}`);
    }
    out.blank();
    out.dim("These apps will lose connectivity when the router is destroyed.");
    out.dim(
      `Consider destroying them first with: ambit destroy app <name>.${network}`,
    );
    out.blank();
  }

  if (!args.yes && !args.json) {
    const confirmed = await confirm("Destroy this router?");
    if (!confirmed) {
      out.text("Cancelled.");
      return;
    }
    out.blank();
  }

  // ===========================================================================
  // Tear Down
  // ===========================================================================

  const dnsSpinner = out.spinner("Clearing Split DNS");
  try {
    await tailscale.clearSplitDns(network);
    dnsSpinner.success("Split DNS Cleared");
  } catch {
    dnsSpinner.fail("Split DNS Already Cleared");
  }

  const deviceSpinner = out.spinner("Removing Tailscale Device");
  try {
    const device = await tailscale.getDeviceByHostname(app.appName);
    if (device) {
      await tailscale.deleteDevice(device.id);
      deviceSpinner.success("Tailscale Device Removed");
    } else {
      deviceSpinner.success("Tailscale Device Not Found (Already Removed)");
    }
  } catch {
    deviceSpinner.fail("Could Not Remove Tailscale Device");
  }

  const appSpinner = out.spinner("Destroying Fly App");
  try {
    await fly.deleteApp(app.appName);
    appSpinner.success("Fly App Destroyed");
  } catch {
    appSpinner.fail("Could Not Destroy Fly App");
  }

  // ===========================================================================
  // Done
  // ===========================================================================

  out.done({
    destroyed: true,
    appName: app.appName,
    workloadAppsWarned: workloadApps.length,
  });

  out.ok("Router Destroyed");

  if (tag) {
    out.blank()
      .dim(
        "If you added ACL policy entries for this router, remember to remove:",
      )
      .dim(`  tagOwners:     ${tag}`)
      .dim(`  autoApprovers: routes for ${tag}`)
      .dim(`  acls:          rules referencing ${tag}`)
      .blank();
  } else {
    out.blank()
      .dim(
        "If you added ACL policy entries for this router, remember to remove",
      )
      .dim("the associated tag from tagOwners, autoApprovers, and acls.")
      .blank();
  }

  out.print();
};

// =============================================================================
// Destroy App
// =============================================================================

const destroyApp = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["network", "org"],
    boolean: ["help", "yes", "json"],
    alias: { y: "yes" },
  });

  if (args.help) {
    console.log(`
${bold("ambit destroy app")} - Destroy a Workload App

${bold("USAGE")}
  ambit destroy app <app>.<network> [--org <org>] [--yes] [--json]
  ambit destroy app <app> --network <name> [--org <org>] [--yes] [--json]

${bold("OPTIONS")}
  --network <name>   Target network (if not using dot syntax)
  --org <org>        Fly.io organization slug
  -y, --yes          Skip confirmation prompts
  --json             Output as JSON

${bold("EXAMPLES")}
  ambit destroy app my-app.browsers
  ambit destroy app my-app --network browsers --yes
`);
    return;
  }

  const out = createOutput<{
    destroyed: boolean;
    appName: string;
    network: string;
  }>(args.json);

  // ===========================================================================
  // Parse App & Network
  // ===========================================================================

  const appArg = args._[0];
  if (!appArg || typeof appArg !== "string") {
    return out.die(
      "Missing app name. Usage: ambit destroy app <app>.<network>",
    );
  }

  let app: string;
  let network: string;

  if (appArg.includes(".")) {
    const parts = appArg.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return out.die(
        `'${appArg}' should have exactly one dot, like my-app.my-network`,
      );
    }
    if (args.network) {
      return out.die(
        `Network is already part of the name ('${appArg}'), --network is not needed`,
      );
    }
    app = parts[0];
    network = parts[1];
  } else {
    app = appArg;
    if (!args.network) {
      return out.die(
        `Missing network. Use: ambit destroy app ${app}.<network>`,
      );
    }
    network = args.network;
  }

  try {
    assertNotRouter(app);
  } catch (e) {
    return out.die(e instanceof Error ? e.message : String(e));
  }

  // ===========================================================================
  // Prerequisites
  // ===========================================================================

  const { tailscaleKey: _tailscaleKey } = await checkDependencies(out);

  const fly = createFlyProvider();
  await fly.ensureAuth({ interactive: !args.json });
  const org = await resolveOrg(fly, args, out);

  // ===========================================================================
  // Discover App
  // ===========================================================================

  const spinner = out.spinner("Discovering App");
  const workloadApp = await findWorkloadApp(fly, org, app, network);

  if (!workloadApp) {
    spinner.fail("App Not Found");

    // Check if app exists on a different network
    const anyApp = await findWorkloadApp(fly, org, app);
    if (anyApp) {
      return out.die(
        `App '${app}' exists on network '${anyApp.network}', not '${network}'`,
      );
    }
    return out.die(`No app '${app}' found on network '${network}'`);
  }

  spinner.success(
    `Found App: ${workloadApp.appName} (network: ${workloadApp.network})`,
  );

  // ===========================================================================
  // Confirm
  // ===========================================================================

  out.blank()
    .header("ambit Destroy App")
    .blank()
    .text(`  App:      ${workloadApp.appName}`)
    .text(`  Network:  ${workloadApp.network}`)
    .blank();

  if (!args.yes && !args.json) {
    const confirmed = await confirm(
      `Destroy app '${app}' on network '${network}'?`,
    );
    if (!confirmed) {
      out.text("Cancelled.");
      return;
    }
    out.blank();
  }

  // ===========================================================================
  // Destroy
  // ===========================================================================

  const appSpinner = out.spinner("Destroying Fly App");
  try {
    await fly.deleteApp(workloadApp.appName);
    appSpinner.success("Fly App Destroyed");
  } catch {
    appSpinner.fail("Could Not Destroy Fly App");
  }

  // ===========================================================================
  // Done
  // ===========================================================================

  out.done({ destroyed: true, appName: workloadApp.appName, network });

  out.ok("App Destroyed");
  out.blank();

  out.print();
};

// =============================================================================
// Dispatcher
// =============================================================================

const destroy = async (argv: string[]): Promise<void> => {
  const subcommand = typeof argv[0] === "string" ? argv[0] : undefined;

  if (subcommand === "network") {
    return destroyNetwork(argv.slice(1));
  }

  if (subcommand === "app") {
    return destroyApp(argv.slice(1));
  }

  // Handle --help at the top level
  const args = parseArgs(argv, { boolean: ["help"] });
  if (args.help) {
    showDestroyHelp();
    return;
  }

  // No valid subcommand
  showDestroyHelp();
  Deno.exit(1);
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "destroy",
  description: "Destroy a network (router) or a workload app",
  usage: "ambit destroy network|app <name> [options]",
  run: destroy,
});
