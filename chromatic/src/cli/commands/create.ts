// =============================================================================
// Create Command - Create a Browser or Browser Pool
// =============================================================================

import { parseArgs } from "@std/cli";
import { z } from "zod";
import { bold, dim, randomId, Spinner } from "@ambit/cli/lib/cli";
import { createOutput } from "@ambit/cli/lib/output";
import { resolveOrg } from "@ambit/cli/src/resolve";
import { registerCommand } from "../mod.ts";
import {
  getDefaultRegion,
  loadConfig,
  type MachineSize,
  MachineSizeEnum,
} from "../../schemas/config.ts";
import {
  convertWsUrlToHostname,
  fetchCdpVersionInfo,
  findCdpApp,
  getCdpAppName,
  getCdpEndpoint,
  InstanceNameSchema,
} from "../../schemas/instance.ts";
import { createFlyProvider } from "@ambit/cli/providers/fly";
import { findRouterApp, getRouterMachineInfo } from "@ambit/cli/src/discovery";

// =============================================================================
// Arg Schemas
// =============================================================================

const CountSchema = z.coerce.number().int().min(1).max(10);

// =============================================================================
// Create Command
// =============================================================================

const create = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["count", "size", "region", "network", "org"],
    boolean: ["help", "json"],
  });

  if (args.help) {
    console.log(`
${bold("chromatic create")} - Create a Browser or Browser Pool

${bold("USAGE")}
  chromatic create <name> [options]

${bold("OPTIONS")}
  --count <n>       Number of machines (default: 1)
  --size <size>     Machine size (default: shared-cpu-1x)
  --region <reg>    Fly.io region (default: iad)
  --network <name>  Network name (default: from config)
  --org <org>       Fly.io organization slug
  --json            Output as JSON

${bold("SIZES")}
  shared-cpu-1x   1 CPU, 1GB RAM
  shared-cpu-2x   2 CPU, 2GB RAM
  shared-cpu-4x   4 CPU, 4GB RAM

${bold("DESCRIPTION")}
  Creates a browser (1 machine, default) or browser pool (N machines with
  --count). A single browser provides a direct CDP connection for stateful
  sessions. A pool is Flycast load-balanced for stateless workloads.

${bold("EXAMPLES")}
  chromatic create my-browser
  chromatic create scrapers --count 3
  chromatic create heavy --size shared-cpu-4x --json
`);
    return;
  }

  const out = createOutput<{
    name: string;
    flyAppName: string;
    endpoint: string;
    machines: {
      id: string;
      state: string;
      size: string;
      region: string;
      privateIp?: string;
    }[];
  }>(args.json);

  const rawName = args._[0] as string | undefined;
  if (!rawName) {
    return out.die("Instance Name Required");
  }

  const nameResult = InstanceNameSchema.safeParse(rawName);
  if (!nameResult.success) {
    return out.die(
      nameResult.error.issues[0]?.message ?? "Invalid Instance Name",
    );
  }
  const name = nameResult.data;

  // Parse count
  const countResult = CountSchema.safeParse(args.count ?? "1");
  if (!countResult.success) {
    return out.die("Count Must Be Between 1 and 10");
  }
  const count = countResult.data;

  const config = await loadConfig();
  const network = args.network ?? config.network;

  // Parse size
  const sizeArg = args.size ?? config.defaults.machineSize;
  const sizeResult = MachineSizeEnum.safeParse(sizeArg);
  if (!sizeResult.success || !sizeResult.data) {
    return out.die(`Invalid Size: ${sizeArg}`);
  }
  const size: MachineSize = sizeResult.data;

  const region = args.region ?? getDefaultRegion();

  const fly = createFlyProvider();
  await fly.ensureInstalled();
  await fly.ensureAuth({ interactive: !args.json });

  const org = await resolveOrg(fly, args, out);

  const type = count === 1 ? "Browser" : "Browser Pool";

  out.blank()
    .header(`Creating ${type}`)
    .blank()
    .info(`Name: ${name}`)
    .info(`Machines: ${count}x ${size}`)
    .info(`Region: ${region}`)
    .blank();

  // Check for existing instance
  const existing = await findCdpApp(fly, org, network, name);
  if (existing) {
    return out.die(`Instance '${name}' Already Exists`);
  }

  // Create app on the custom 6PN network
  const appName = getCdpAppName(name, randomId(4));

  const spinner = new Spinner();
  if (!out.isJson()) spinner.start(`Creating App: ${appName}`);
  await fly.createApp(appName, org, { network });
  if (!out.isJson()) spinner.success(`Created App: ${appName}`);

  // Discover router for SOCKS proxy
  const routerApp = await findRouterApp(fly, org, network);
  if (routerApp) {
    const routerMachine = await getRouterMachineInfo(fly, routerApp.appName);
    if (routerMachine?.privateIp) {
      await fly.setSecrets(appName, {
        ROUTER_PROXY: `socks5://[${routerMachine.privateIp}]:1080`,
      }, { stage: true });
      out.ok(`SOCKS Proxy: socks5://[${routerMachine.privateIp}]:1080`);
    }
  }

  // Deploy CDP image (creates first machine)
  const dockerDir = new URL("../../docker/cdp", import.meta.url).pathname;

  out.blank().dim("Deploying CDP Image...");
  await fly.routerDeploy(appName, dockerDir, { region });
  out.ok("CDP Image Deployed");

  // Create additional machines if count > 1 (deploy already created 1)
  if (count > 1) {
    out.blank().dim(`Creating ${count - 1} Additional Machine(s)...`);

    for (let i = 1; i < count; i++) {
      const machine = await fly.createMachine(appName, {
        size,
        region,
        autoStopSeconds: config.defaults.autoStopSeconds,
      });
      out.ok(`Created Machine: ${machine.id.slice(0, 8)}`);
    }
  }

  // Fetch live WebSocket URL
  const machines = await fly.listMachinesMapped(appName);
  const runningMachine = machines.find((m) =>
    m.state === "running" && m.privateIp
  );

  let wsEndpoint = getCdpEndpoint(appName, network);
  if (runningMachine?.privateIp) {
    const cdpInfo = await fetchCdpVersionInfo(runningMachine.privateIp);
    if (cdpInfo) {
      wsEndpoint = convertWsUrlToHostname(
        cdpInfo.webSocketDebuggerUrl,
        appName,
        network,
      );
    }
  }

  out.blank()
    .header("=".repeat(50))
    .header(`  ${type} Created: ${name}`)
    .header("=".repeat(50))
    .blank()
    .text(`CDP Endpoint: ${bold(wsEndpoint)}`)
    .blank()
    .dim("Connect with Puppeteer:")
    .dim(`  const browser = await puppeteer.connect({`)
    .dim(`    browserWSEndpoint: '${wsEndpoint}'`)
    .dim(`  });`)
    .blank();

  out.done({
    name,
    flyAppName: appName,
    endpoint: wsEndpoint,
    machines: machines.map((m) => ({
      id: m.id,
      state: m.state,
      size: m.size,
      region: m.region,
      privateIp: m.privateIp,
    })),
  });
  out.print();
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "create",
  description: "Create a browser (1 machine) or browser pool (N machines)",
  usage:
    "chromatic create <name> [--count N] [--size SIZE] [--network NAME] [--org ORG] [--json]",
  run: create,
});
