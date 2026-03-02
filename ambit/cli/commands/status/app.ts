// =============================================================================
// Status App — Show App Status
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput } from "@/lib/output.ts";
import type { FlyProvider } from "@/providers/fly.ts";
import type { TailscaleProvider } from "@/providers/tailscale.ts";
import {
  findRouterApp,
  findWorkloadApp,
  getRouterMachineInfo,
  getRouterTailscaleInfo,
  type RouterApp,
} from "@/util/discovery.ts";
import { initSession } from "@/util/session.ts";
import { SOCKS_PROXY_PORT } from "@/util/constants.ts";

// =============================================================================
// Detailed App View
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
    .text(`  Status:        ${workload.status}`)
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

export const statusApp = async (argv: string[]): Promise<void> => {
  const opts = {
    string: ["org"],
    boolean: ["help", "json"],
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit status app");

  if (args.help) {
    console.log(`
${bold("ambit status app")} - Show App Status

${bold("USAGE")}
  ambit status app <app>.<network> [--org <org>] [--json]

${bold("OPTIONS")}
  --org <org>        Fly.io organization slug
  --json             Output as JSON

${bold("EXAMPLES")}
  ambit status app my-app.browsers
  ambit status app my-app.browsers --json
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

  if (!appArg.includes(".")) {
    return out.die(
      `Missing Network. Use: ambit status app ${appArg}.<network>`,
    );
  }

  const parts = appArg.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return out.die(
      `'${appArg}' Should Have Exactly One Dot, Like my-app.my-network`,
    );
  }
  const app = parts[0];
  const network = parts[1];

  const prereqOut = createOutput<Record<string, unknown>>(args.json);
  const { fly, tailscale, org } = await initSession(prereqOut, {
    json: args.json,
    org: args.org,
  });

  await stageAppStatus(fly, tailscale, app, network, org, args.json);
};
