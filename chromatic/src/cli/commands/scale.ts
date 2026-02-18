// =============================================================================
// Scale Command - Declarative Machine Scaling
// =============================================================================

import { parseArgs } from "@std/cli";
import { z } from "zod";
import { bold, confirm, green, red } from "@ambit/cli/lib/cli";
import { createOutput } from "@ambit/cli/lib/output";
import { resolveOrg } from "@ambit/cli/src/resolve";
import { registerCommand } from "../mod.ts";
import {
  getDefaultRegion,
  loadConfig,
  type MachineSize,
} from "../../schemas/config.ts";
import {
  findCdpApp,
  formatMachineSizeSummary,
  getMachineSizeSummary,
  type MachineSizeSummary,
} from "../../schemas/instance.ts";
import { createFlyProvider } from "@ambit/cli/providers/fly";

// =============================================================================
// Arg Schemas
// =============================================================================

const ScaleCountSchema = z.coerce.number().int().min(0).max(20);

// =============================================================================
// Scale Command
// =============================================================================

const scale = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: [
      "shared-cpu-1x",
      "shared-cpu-2x",
      "shared-cpu-4x",
      "network",
      "org",
      "region",
    ],
    boolean: ["help", "yes", "json"],
    alias: { y: "yes" },
  });

  if (args.help) {
    console.log(`
${bold("chromatic scale")} - Scale Machines in a Browser Pool

${bold("USAGE")}
  chromatic scale <name> [options]
  chromatic scale <name> <count>

${bold("OPTIONS")}
  --shared-cpu-1x <n>   Number of 1x machines
  --shared-cpu-2x <n>   Number of 2x machines
  --shared-cpu-4x <n>   Number of 4x machines
  --region <reg>        Fly.io region for new machines (default: iad)
  --network <name>      Network name (default: from config)
  --org <org>           Fly.io organization slug
  -y, --yes             Skip confirmation
  --json                Output as JSON

${bold("DESCRIPTION")}
  Add or remove machines in a browser pool. Each machine runs an independent
  Chrome instance. Connections are load-balanced across all machines.

${bold("EXAMPLES")}
  chromatic scale scrapers 5
  chromatic scale scrapers --shared-cpu-1x 3 --shared-cpu-2x 2
  chromatic scale scrapers --shared-cpu-4x 2 --json
`);
    return;
  }

  const out = createOutput<Record<string, unknown>>(args.json);

  const name = args._[0] as string | undefined;
  if (!name) {
    return out.die("Instance Name Required");
  }

  const config = await loadConfig();
  const network = args.network ?? config.network;
  const region = args.region ?? getDefaultRegion();

  const fly = createFlyProvider();
  await fly.ensureInstalled();
  await fly.ensureAuth({ interactive: !args.json });

  const org = await resolveOrg(fly, args, out);

  const app = await findCdpApp(fly, org, network, name);
  if (!app) {
    return out.die(`Instance '${name}' Not Found`);
  }

  const machines = await fly.listMachinesMapped(app.flyAppName);
  const currentSummary = getMachineSizeSummary({
    name,
    flyAppName: app.flyAppName,
    machines: machines.map((m) => ({
      id: m.id,
      state: m.state as "creating" | "running" | "frozen" | "failed",
      size: m.size as "shared-cpu-1x" | "shared-cpu-2x" | "shared-cpu-4x",
      region: m.region,
      privateIp: m.privateIp,
    })),
  });

  // Parse desired state
  let desiredSummary: MachineSizeSummary;

  const simpleCount = args._[1] as string | undefined;
  if (simpleCount) {
    const countResult = ScaleCountSchema.safeParse(simpleCount);
    if (!countResult.success) {
      return out.die("Count Must Be Between 0 and 20");
    }

    desiredSummary = {
      "shared-cpu-1x": countResult.data,
      "shared-cpu-2x": 0,
      "shared-cpu-4x": 0,
    };
  } else {
    const parse = (val: string | undefined): number => {
      if (!val) return 0;
      const result = ScaleCountSchema.safeParse(val);
      return result.success ? result.data : 0;
    };

    desiredSummary = {
      "shared-cpu-1x": parse(args["shared-cpu-1x"]),
      "shared-cpu-2x": parse(args["shared-cpu-2x"]),
      "shared-cpu-4x": parse(args["shared-cpu-4x"]),
    };

    const totalDesired = desiredSummary["shared-cpu-1x"] +
      desiredSummary["shared-cpu-2x"] +
      desiredSummary["shared-cpu-4x"];

    if (totalDesired === 0) {
      return out.die("Specify Count or Size Options");
    }
  }

  // Calculate diff
  const diff: Record<MachineSize, number> = {
    "shared-cpu-1x": desiredSummary["shared-cpu-1x"] -
      currentSummary["shared-cpu-1x"],
    "shared-cpu-2x": desiredSummary["shared-cpu-2x"] -
      currentSummary["shared-cpu-2x"],
    "shared-cpu-4x": desiredSummary["shared-cpu-4x"] -
      currentSummary["shared-cpu-4x"],
  };

  const totalCurrent = currentSummary["shared-cpu-1x"] +
    currentSummary["shared-cpu-2x"] +
    currentSummary["shared-cpu-4x"];
  const totalDesired = desiredSummary["shared-cpu-1x"] +
    desiredSummary["shared-cpu-2x"] +
    desiredSummary["shared-cpu-4x"];

  // Compute changes
  const toCreate: { size: MachineSize; count: number }[] = [];
  const toDestroy: { size: MachineSize; count: number }[] = [];

  for (
    const size of [
      "shared-cpu-1x",
      "shared-cpu-2x",
      "shared-cpu-4x",
    ] as MachineSize[]
  ) {
    const change = diff[size];
    if (change > 0) {
      toCreate.push({ size, count: change });
    } else if (change < 0) {
      toDestroy.push({ size, count: -change });
    }
  }

  if (toCreate.length === 0 && toDestroy.length === 0) {
    out.ok("Already at Desired Scale");
    out.done({ name, changed: false, current: currentSummary });
    out.print();
    return;
  }

  out.blank()
    .header(`Scaling: ${name}`)
    .blank()
    .text(
      `Current:  ${
        formatMachineSizeSummary(currentSummary)
      } (${totalCurrent} total)`,
    )
    .text(
      `Desired:  ${
        formatMachineSizeSummary(desiredSummary)
      } (${totalDesired} total)`,
    )
    .blank()
    .text("Changes:");

  for (const { size, count } of toCreate) {
    out.text(green(`  + ${count}x ${size}`));
  }
  for (const { size, count } of toDestroy) {
    out.text(red(`  - ${count}x ${size}`));
  }
  out.blank();

  // Confirm if destroying
  if (toDestroy.length > 0 && !args.yes && !out.isJson()) {
    const shouldProceed = await confirm("Apply Changes?");
    if (!shouldProceed) {
      out.text("Cancelled.");
      out.print();
      return;
    }
    out.blank();
  }

  // Destroy first
  for (const { size, count } of toDestroy) {
    const machinesOfSize = machines.filter((m) => m.size === size);
    const toDestroyMachines = machinesOfSize.slice(0, count);

    for (const machine of toDestroyMachines) {
      await fly.destroyMachine(app.flyAppName, machine.id);
    }
  }

  // Then create
  for (const { size, count } of toCreate) {
    for (let i = 0; i < count; i++) {
      await fly.createMachine(app.flyAppName, {
        size: size as "shared-cpu-1x" | "shared-cpu-2x" | "shared-cpu-4x",
        region,
        autoStopSeconds: config.defaults.autoStopSeconds,
      });
    }
  }

  out.blank().ok("Scaling Complete");
  out.done({
    name,
    changed: true,
    previous: currentSummary,
    current: desiredSummary,
    created: toCreate,
    destroyed: toDestroy,
  });
  out.print();
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "scale",
  description: "Scale machines in a browser pool",
  usage:
    "chromatic scale <name> [count] [--shared-cpu-Nx N] [--network NAME] [--org ORG]",
  run: scale,
});
