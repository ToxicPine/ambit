// =============================================================================
// Status Command - Show Router Status
// =============================================================================

import { parseArgs } from "@std/cli";
import { Table } from "@cliffy/table";
import { bold } from "@/lib/cli.ts";
import { createOutput } from "@/lib/output.ts";
import { registerCommand } from "../mod.ts";
import { createFlyProvider, type FlyProvider } from "@/src/providers/fly.ts";
import {
  createTailscaleProvider,
  type TailscaleProvider,
} from "@/src/providers/tailscale.ts";
import { checkDependencies } from "@/src/credentials.ts";
import {
  findRouterApp,
  getRouterMachineInfo,
  getRouterTailscaleInfo,
  listRouterApps,
  type RouterApp,
  type RouterMachineInfo,
  type RouterTailscaleInfo,
} from "@/src/discovery.ts";
import { resolveOrg } from "@/src/resolve.ts";

// =============================================================================
// Status Command
// =============================================================================

const status = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["network", "org"],
    boolean: ["help", "json"],
  });

  if (args.help) {
    console.log(`
${bold("ambit status")} - Show Router Status

${bold("USAGE")}
  ambit status [--network <name>] [--org <org>] [--json]

${bold("OPTIONS")}
  --network <name>   Show detailed status for a specific network
  --org <org>        Fly.io organization slug
  --json             Output as JSON

${bold("EXAMPLES")}
  ambit status                     Show summary of all routers
  ambit status --network browsers  Show detailed status for one router
`);
    return;
  }

  // =========================================================================
  // Prerequisites
  // =========================================================================

  const { tailscaleKey } = await checkDependencies(createOutput(args.json));

  const fly = createFlyProvider();
  await fly.ensureAuth({ interactive: !args.json });
  const tailscale = createTailscaleProvider("-", tailscaleKey);

  // =========================================================================
  // Status
  // =========================================================================

  if (args.network) {
    await showNetworkStatus(fly, tailscale, args);
  } else {
    await showAllStatus(fly, tailscale, args);
  }
};

// =============================================================================
// Single Router Detailed View
// =============================================================================

const showNetworkStatus = async (
  fly: FlyProvider,
  tailscale: TailscaleProvider,
  args: { network?: string; org?: string; json: boolean },
): Promise<void> => {
  const out = createOutput<{
    network: string;
    router: RouterApp;
    machine: RouterMachineInfo | null;
    tag: string | null;
    tailscale: RouterTailscaleInfo | null;
  }>(args.json);

  const org = await resolveOrg(fly, args, out);

  const app = await findRouterApp(fly, org, args.network!);
  if (!app) {
    return out.die(`No Router Found for Network '${args.network}'`);
  }

  const machine = await getRouterMachineInfo(fly, app.appName);
  const ts = await getRouterTailscaleInfo(tailscale, app.appName);
  const tag = ts?.tags?.[0] ?? null;

  out.blank()
    .header("ambit Status")
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
        machine?.privateIp ? `socks5://[${machine.privateIp}]:1080` : "unknown"
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
// Summary Table of All Routers
// =============================================================================

const showAllStatus = async (
  fly: FlyProvider,
  tailscale: TailscaleProvider,
  args: { org?: string; json: boolean },
): Promise<void> => {
  const out = createOutput<{
    routers: (RouterApp & {
      machine: RouterMachineInfo | null;
      tailscale: RouterTailscaleInfo | null;
    })[];
  }>(args.json);

  const org = await resolveOrg(fly, args, out);

  const spinner = out.spinner("Discovering Routers");
  const routerApps = await listRouterApps(fly, org);
  spinner.success(
    `Found ${routerApps.length} Router${routerApps.length !== 1 ? "s" : ""}`,
  );

  if (routerApps.length === 0) {
    out.blank()
      .text("No Routers Found.")
      .dim("  Create one with: ambit create <network>")
      .blank();

    out.done({ routers: [] });
    out.print();
    return;
  }

  const routers: (RouterApp & {
    machine: RouterMachineInfo | null;
    tailscale: RouterTailscaleInfo | null;
  })[] = [];

  for (const app of routerApps) {
    const machine = await getRouterMachineInfo(fly, app.appName);
    const ts = await getRouterTailscaleInfo(tailscale, app.appName);
    routers.push({ ...app, machine, tailscale: ts });
  }

  out.blank().header("Router Status").blank();

  const rows = routers.map((r) => {
    const tsStatus = r.tailscale
      ? r.tailscale.online ? "online" : "offline"
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
// Register Command
// =============================================================================

registerCommand({
  name: "status",
  description: "Show router status, network, and tailnet info",
  usage: "ambit status [--network <name>] [--org <org>] [--json]",
  run: status,
});
