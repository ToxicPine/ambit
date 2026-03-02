// =============================================================================
// Status Network — Show Detailed Status for a Single Network
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput } from "@/lib/output.ts";
import type { FlyProvider } from "@/providers/fly.ts";
import type { TailscaleProvider } from "@/providers/tailscale.ts";
import {
  findRouterApp,
  getRouterMachineInfo,
  getRouterTailscaleInfo,
  listWorkloadAppsOnNetwork,
  type RouterApp,
  type RouterMachineInfo,
  type RouterTailscaleInfo,
} from "@/util/discovery.ts";
import { initSession } from "@/util/session.ts";
import { SOCKS_PROXY_PORT } from "@/util/constants.ts";

// =============================================================================
// Detailed View
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
    .text(`  Status:        ${app.status}`)
    .blank()
    .text(`  Router App:    ${app.appName}`)
    .text(`  Region:        ${machine?.region ?? "unknown"}`)
    .text(`  Machine State: ${machine?.state ?? "no machines"}`)
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
// Status Network Subcommand
// =============================================================================

export const statusNetwork = async (argv: string[]): Promise<void> => {
  const opts = { string: ["org"], boolean: ["help", "json"] } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit status network");

  if (args.help) {
    console.log(`
${bold("ambit status network")} - Show Detailed Status for a Network

${bold("USAGE")}
  ambit status network <name> [--org <org>] [--json]

${bold("OPTIONS")}
  --org <org>        Fly.io organization slug
  --json             Output as JSON

${bold("EXAMPLES")}
  ambit status network browsers
`);
    return;
  }

  const out = createOutput<Record<string, unknown>>(args.json);

  const network = typeof args._[0] === "string" ? args._[0] : undefined;
  if (!network) {
    return out.die(
      "Missing Network Name. Usage: ambit status network <name>",
    );
  }

  const prereqOut = createOutput<Record<string, unknown>>(args.json);
  const { fly, tailscale, org } = await initSession(prereqOut, {
    json: args.json,
    org: args.org,
  });

  await stageNetworkStatus(fly, tailscale, network, org, args.json);
};
