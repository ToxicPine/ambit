// =============================================================================
// Status Command - Show Network, App, and Router Status
// =============================================================================

import { parseArgs } from "@std/cli";
import { Table } from "@cliffy/table";
import { bold } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput } from "@/lib/output.ts";
import { registerCommand } from "@/cli/mod.ts";
import type { FlyProvider } from "@/providers/fly.ts";
import type { TailscaleProvider } from "@/providers/tailscale.ts";
import {
  discoverRouters,
  findRouterApp,
  findWorkloadApp,
  getRouterMachineInfo,
  getRouterTailscaleInfo,
  listWorkloadAppsOnNetwork,
  type RouterApp,
  type RouterMachineInfo,
  type RouterTailscaleInfo,
  type RouterWithInfo,
} from "@/util/discovery.ts";
import { initSession } from "@/util/session.ts";
import { SOCKS_PROXY_PORT } from "@/util/constants.ts";

// =============================================================================
// Network Status: Single Router Detailed View
// =============================================================================

const stageNetworkStatus = async (
  fly: FlyProvider,
  tailscale: TailscaleProvider,
  network: string,
  org: string,
  json: boolean,
): Promise<void> => {
  const out = createOutput<{
    network: string;
    router: RouterApp;
    machine: RouterMachineInfo | null;
    tag: string | null;
    tailscale: RouterTailscaleInfo | null;
  }>(json);

  const app = await findRouterApp(fly, org, network);
  if (!app) {
    return out.die(`No Router Found for Network '${network}'`);
  }

  const machine = await getRouterMachineInfo(fly, app.appName);
  const ts = await getRouterTailscaleInfo(tailscale, app.appName);
  const tag = ts?.tags?.[0] ?? null;

  out.blank()
    .header("Ambit Status: Network")
    .blank()
    .text(`  Network:       ${bold(app.network)}`)
    .text(`  TLD:           *.${app.network}`)
    .text(`  Tag:           ${tag ?? "unknown"}`)
    .blank()
    .text(`  Router App:    ${app.appName}`)
    .text(`  Region:        ${machine?.region ?? "unknown"}`)
    .text(`  Machine State: ${machine?.state ?? "unknown"}`)
    .text(`  Private IP:    ${machine?.privateIp ?? "unknown"}`)
    .text(
      `  SOCKS Proxy:   ${
        machine?.privateIp
          ? `socks5://[${machine.privateIp}]:${SOCKS_PROXY_PORT}`
          : "unknown"
      }`,
    );

  if (machine?.subnet) {
    out.text(`  Subnet:        ${machine.subnet}`);
  }

  out.blank();

  if (ts) {
    out.text(`  Tailscale IP:  ${ts.ip}`)
      .text(`  Online:        ${ts.online ? "yes" : "no"}`);
  } else {
    out.text("  Tailscale:     Not Found in Tailnet");
  }

  // Show workload apps on this network
  const workloads = await listWorkloadAppsOnNetwork(fly, org, network);
  if (workloads.length > 0) {
    out.blank().header("  Apps on Network").blank();
    for (const w of workloads) {
      const machines = await fly.machines.list(w.appName);
      const state = machines[0]?.state ?? "no machines";
      const region = machines[0]?.region ?? "-";
      out.text(`    ${w.appName}  ${region}  ${state}`);
    }
  }

  out.blank();

  out.done({
    network: app.network,
    router: app,
    machine,
    tag,
    tailscale: ts,
  });

  out.print();
};

// =============================================================================
// Network Status: Summary Table of All Routers
// =============================================================================

const stageAllStatus = async (
  fly: FlyProvider,
  tailscale: TailscaleProvider,
  org: string,
  json: boolean,
): Promise<void> => {
  const out = createOutput<{ routers: RouterWithInfo[] }>(json);

  const routers = await discoverRouters(out, fly, tailscale, org);

  if (routers.length === 0) {
    out.blank()
      .text("No Routers Found.")
      .dim("  Create One with: ambit create <network>")
      .blank();
    out.done({ routers: [] });
    out.print();
    return;
  }

  out.blank().header("Router Status").blank();

  const rows = routers.map((r) => {
    const tsStatus = r.tailscale
      ? (r.tailscale.online ? "online" : "offline")
      : "not found";
    return [r.network, r.appName, r.machine?.state ?? "unknown", tsStatus];
  });

  const table = new Table()
    .header(["Network", "App", "State", "Tailscale"])
    .body(rows)
    .indent(2)
    .padding(2);

  out.text(table.toString());
  out.blank();
  out.done({ routers });
  out.print();
};

// =============================================================================
// Status Network Subcommand
// =============================================================================

const statusNetwork = async (argv: string[]): Promise<void> => {
  const opts = { string: ["org"], boolean: ["help", "json"] } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit status network");

  if (args.help) {
    console.log(`
${bold("ambit status network")} - Show Router and Network Status

${bold("USAGE")}
  ambit status network [<name>] [--org <org>] [--json]

${bold("OPTIONS")}
  <name>             Network to show status for (shows all if omitted)
  --org <org>        Fly.io organization slug
  --json             Output as JSON

${bold("EXAMPLES")}
  ambit status network              Show summary of all routers
  ambit status network browsers     Show detailed status for one network
`);
    return;
  }

  const network = typeof args._[0] === "string" ? args._[0] : undefined;

  const prereqOut = createOutput<Record<string, unknown>>(args.json);
  const { fly, tailscale, org } = await initSession(prereqOut, {
    json: args.json,
    org: args.org,
  });

  if (network) {
    await stageNetworkStatus(fly, tailscale, network, org, args.json);
  } else {
    await stageAllStatus(fly, tailscale, org, args.json);
  }
};

// =============================================================================
// App Status: Detailed App View
// =============================================================================

const stageAppStatus = async (
  fly: FlyProvider,
  tailscale: TailscaleProvider,
  app: string,
  network: string,
  org: string,
  json: boolean,
): Promise<void> => {
  const out = createOutput<{
    app: string;
    network: string;
    flyAppName: string;
    machines: Array<{
      id: string;
      region: string;
      state: string;
      privateIp?: string;
    }>;
    ips: Array<{ address: string; type: string; network?: string }>;
    router: RouterApp | null;
  }>(json);

  const workload = await findWorkloadApp(fly, org, app, network);

  if (!workload) {
    return out.die(`App '${app}' Not Found on Network '${network}'`);
  }

  const machines = await fly.machines.list(workload.appName);
  const ips = await fly.ips.list(workload.appName);

  const mappedMachines = machines.map((m) => ({
    id: m.id,
    region: m.region,
    state: m.state,
    privateIp: m.private_ip,
  }));

  const mappedIps = ips.map((ip) => ({
    address: ip.Address,
    type: ip.Type,
    network: ip.Network?.Name,
  }));

  const router = await findRouterApp(fly, org, network);

  out.blank()
    .header(`Ambit Status: ${app}.${network}`)
    .blank()
    .text(`  App:           ${bold(app)}`)
    .text(`  Network:       ${network}`)
    .text(`  Fly App:       ${workload.appName}`)
    .blank();

  if (machines.length === 0) {
    out.text("  Machines:      None");
  } else {
    out.header("  Machines").blank();
    for (const m of machines) {
      out.text(
        `    ${m.id}  ${m.region}  ${m.state}${
          m.private_ip ? `  ${m.private_ip}` : ""
        }`,
      );
    }
  }

  out.blank();

  const flycastIps = ips.filter((ip) => ip.Type === "private_v6");
  const publicIps = ips.filter((ip) => ip.Type !== "private_v6");

  if (flycastIps.length > 0) {
    out.header("  Flycast IPs").blank();
    for (const ip of flycastIps) {
      out.text(
        `    ${ip.Address}  (network: ${ip.Network?.Name ?? "default"})`,
      );
    }
    out.blank();
  }

  if (publicIps.length > 0) {
    out.header("  Public IPs (Warning: Ambit Apps Should Not Have Public IPs)")
      .blank();
    for (const ip of publicIps) {
      out.text(`    ${ip.Address}  ${ip.Type}`);
    }
    out.blank();
  }

  if (router) {
    const routerMachine = await getRouterMachineInfo(fly, router.appName);
    const ts = await getRouterTailscaleInfo(tailscale, router.appName);

    out.header("  Router").blank()
      .text(`    App:         ${router.appName}`)
      .text(`    State:       ${routerMachine?.state ?? "unknown"}`)
      .text(
        `    Tailscale:   ${
          ts ? (ts.online ? "online" : "offline") : "not found"
        }`,
      );

    if (routerMachine?.privateIp) {
      out.text(
        `    SOCKS Proxy: socks5://[${routerMachine.privateIp}]:${SOCKS_PROXY_PORT}`,
      );
    }
  } else {
    out.text("  Router:        Not Found");
  }

  out.blank();

  out.done({
    app,
    network,
    flyAppName: workload.appName,
    machines: mappedMachines,
    ips: mappedIps,
    router,
  });

  out.print();
};

// =============================================================================
// Status App Subcommand
// =============================================================================

const statusApp = async (argv: string[]): Promise<void> => {
  const opts = {
    string: ["network", "org"],
    boolean: ["help", "json"],
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit status app");

  if (args.help) {
    console.log(`
${bold("ambit status app")} - Show App Status

${bold("USAGE")}
  ambit status app <app>.<network> [--org <org>] [--json]
  ambit status app <app> --network <name> [--org <org>] [--json]

${bold("OPTIONS")}
  --network <name>   Target network (if not using dot syntax)
  --org <org>        Fly.io organization slug
  --json             Output as JSON

${bold("EXAMPLES")}
  ambit status app my-app.browsers
  ambit status app my-app --network browsers --json
`);
    return;
  }

  const out = createOutput<Record<string, unknown>>(args.json);

  const appArg = args._[0];
  if (!appArg || typeof appArg !== "string") {
    return out.die(
      "Missing App Name. Usage: ambit status app <app>.<network>",
    );
  }

  let app: string;
  let network: string;

  if (appArg.includes(".")) {
    const parts = appArg.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return out.die(
        `'${appArg}' Should Have Exactly One Dot, Like my-app.my-network`,
      );
    }
    app = parts[0];
    network = parts[1];
  } else {
    app = appArg;
    if (!args.network) {
      return out.die(
        `Missing Network. Use: ambit status app ${app}.<network>`,
      );
    }
    network = args.network;
  }

  const prereqOut = createOutput<Record<string, unknown>>(args.json);
  const { fly, tailscale, org } = await initSession(prereqOut, {
    json: args.json,
    org: args.org,
  });

  await stageAppStatus(fly, tailscale, app, network, org, args.json);
};

// =============================================================================
// Top-Level Help
// =============================================================================

const showStatusHelp = (): void => {
  console.log(`
${bold("ambit status")} - Show Network, App, and Router Status

${bold("USAGE")}
  ambit status [options]
  ambit status network [<name>] [options]
  ambit status app <app>.<network> [options]

${bold("SUBCOMMANDS")}
  network    Show router/network status — default when no subcommand given
  app        Show a specific app's status

${bold("OPTIONS")}
  --org <org>        Fly.io organization slug
  --json             Output as JSON

${bold("EXAMPLES")}
  ambit status
  ambit status network
  ambit status network browsers
  ambit status app my-app.browsers

Run 'ambit status network --help' or 'ambit status app --help' for details.
`);
};

// =============================================================================
// Dispatcher
// =============================================================================

const status = async (argv: string[]): Promise<void> => {
  const subcommand = typeof argv[0] === "string" ? argv[0] : undefined;

  if (subcommand === "network") return statusNetwork(argv.slice(1));
  if (subcommand === "app") return statusApp(argv.slice(1));

  const args = parseArgs(argv, { boolean: ["help"] });
  if (args.help) {
    showStatusHelp();
    return;
  }

  return statusNetwork(argv);
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "status",
  description: "Show network, app, and router status",
  usage: "ambit status [network|app] [<name>] [--org <org>] [--json]",
  run: status,
});
