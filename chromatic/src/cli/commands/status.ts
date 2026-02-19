// =============================================================================
// Status Command - Show Browser/Pool Details
// =============================================================================

import { parseArgs } from "@std/cli";
import { Table } from "@cliffy/table";
import { bold, cyan, dim, green, red, yellow } from "@cardelli/ambit/lib/cli";
import { createOutput } from "@cardelli/ambit/lib/output";
import { resolveOrg } from "@cardelli/ambit/src/resolve";
import { registerCommand } from "../mod.ts";
import { loadConfig } from "../../schemas/config.ts";
import {
  convertWsUrlToHostname,
  fetchCdpVersionInfo,
  findCdpApp,
  formatMachineSizeSummary,
  getCdpEndpoint,
  getCdpMachineEndpoint,
  getInstanceStateSummary,
  getMachineSizeSummary,
  type Instance,
  type MachineState,
} from "../../schemas/instance.ts";
import { createFlyProvider } from "@cardelli/ambit/providers/fly";

// =============================================================================
// State Colors
// =============================================================================

const stateColor = (state: MachineState): string => {
  switch (state) {
    case "running":
      return green(state);
    case "frozen":
      return cyan(state);
    case "creating":
      return yellow(state);
    case "failed":
      return red(state);
  }
};

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
${bold("chromatic status")} - Show Browser/Pool Details

${bold("USAGE")}
  chromatic status <name> [options]

${bold("OPTIONS")}
  --network <name>  Network name (default: from config)
  --org <org>       Fly.io organization slug
  --json            Output as JSON

${bold("DESCRIPTION")}
  Shows all machines in a browser or pool with their state and private IPs.
  Use per-machine IPs for sticky sessions to a specific Chrome instance.

${bold("EXAMPLES")}
  chromatic status my-browser
  chromatic status scrapers --json
`);
    return;
  }

  const out = createOutput<Instance>(args.json);

  const nameArg = args._[0];
  if (!nameArg || typeof nameArg !== "string") {
    return out.die("Instance Name Required");
  }
  const name = nameArg;

  const config = await loadConfig();
  const network = args.network ?? config.network;

  const fly = createFlyProvider();
  await fly.ensureInstalled();
  await fly.ensureAuth({ interactive: !args.json });

  const org = await resolveOrg(fly, args, out);

  const app = await findCdpApp(fly, org, network, name);
  if (!app) {
    return out.die(`Instance '${name}' Not Found`);
  }

  const machines = await fly.listMachinesMapped(app.flyAppName);

  const instance: Instance = {
    name,
    flyAppName: app.flyAppName,
    machines: machines.map((m) => ({
      id: m.id,
      state: m.state as "creating" | "running" | "frozen" | "failed",
      size: m.size as "shared-cpu-1x" | "shared-cpu-2x" | "shared-cpu-4x",
      region: m.region,
      privateIp: m.privateIp,
    })),
  };

  const summary = getInstanceStateSummary(instance);
  const sizeSummary = getMachineSizeSummary(instance);
  const endpoint = getCdpEndpoint(instance.flyAppName, network);
  const type = summary.total === 1
    ? "browser"
    : `pool (${summary.total} machines)`;

  out.blank()
    .header(`Instance: ${name}`)
    .text(`App:      ${instance.flyAppName}`)
    .text(`Type:     ${type}`)
    .text(`Endpoint: ${endpoint}`)
    .blank()
    .text(
      `Machines: ${summary.total} (${formatMachineSizeSummary(sizeSummary)})`,
    );

  if (instance.machines.length > 0) {
    out.blank();

    const rows = instance.machines.map((machine) => [
      machine.id.slice(0, 10),
      machine.size,
      stateColor(machine.state),
      machine.privateIp ?? "-",
    ]);

    const table = new Table()
      .header(["ID", "Size", "State", "Private IP"])
      .body(rows)
      .indent(2)
      .padding(2);

    out.text(table.toString());
  }

  out.blank();

  // Fetch live WebSocket URL from a running machine
  const runningMachine = instance.machines.find((m) =>
    m.state === "running" && m.privateIp
  );
  if (runningMachine?.privateIp) {
    const cdpInfo = await fetchCdpVersionInfo(runningMachine.privateIp);
    if (cdpInfo) {
      const wsUrl = convertWsUrlToHostname(
        cdpInfo.webSocketDebuggerUrl,
        instance.flyAppName,
        network,
      );
      out.header("Connect with Puppeteer:")
        .dim(`  const browser = await puppeteer.connect({`)
        .dim(`    browserWSEndpoint: '${wsUrl}'`)
        .dim(`  });`)
        .blank();
    }
  } else if (instance.machines.some((m) => m.privateIp)) {
    out.dim("Tip: Connect to a Specific Machine:");
    const machineWithIp = instance.machines.find((m) => m.privateIp);
    if (machineWithIp?.privateIp) {
      out.dim(`  ${getCdpMachineEndpoint(machineWithIp.privateIp)}`);
    }
    out.blank();
  }

  out.done(instance);
  out.print();
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "status",
  description: "Show browser/pool details including machines and endpoints",
  usage: "chromatic status <name> [--network NAME] [--org ORG] [--json]",
  run: status,
});
