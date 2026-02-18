// =============================================================================
// List Command - List All Browsers and Pools
// =============================================================================

import { parseArgs } from "@std/cli";
import { Table } from "@cliffy/table";
import { bold, dim } from "@ambit/cli/lib/cli";
import { createOutput } from "@ambit/cli/lib/output";
import { resolveOrg } from "@ambit/cli/src/resolve";
import { registerCommand } from "../mod.ts";
import { loadConfig } from "../../schemas/config.ts";
import {
  getInstanceStateSummary,
  formatInstanceState,
  getCdpEndpoint,
  listCdpApps,
  type Instance,
} from "../../schemas/instance.ts";
import { createFlyProvider } from "@ambit/cli/providers/fly";

// =============================================================================
// List Command
// =============================================================================

const list = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["network", "org"],
    boolean: ["help", "json"],
  });

  if (args.help) {
    console.log(`
${bold("chromatic list")} - List All Browsers and Pools

${bold("USAGE")}
  chromatic list [options]

${bold("OPTIONS")}
  --network <name>  Network name (default: from config)
  --org <org>       Fly.io organization slug
  --json            Output as JSON

${bold("EXAMPLES")}
  chromatic list
  chromatic list --org my-org
  chromatic list --json
`);
    return;
  }

  const out = createOutput<{ instances: Instance[] }>(args.json);

  const config = await loadConfig();
  const network = args.network ?? config.network;

  const fly = createFlyProvider();
  await fly.ensureInstalled();
  await fly.ensureAuth({ interactive: !args.json });

  const org = await resolveOrg(fly, args, out);

  const cdpApps = await listCdpApps(fly, org, network);

  if (cdpApps.length === 0) {
    out.blank()
      .dim("No Browsers Found")
      .dim("Create one with: chromatic create <name>")
      .blank();
    out.done({ instances: [] });
    out.print();
    return;
  }

  const instances: Instance[] = [];

  for (const app of cdpApps) {
    const machines = await fly.listMachinesMapped(app.flyAppName);

    instances.push({
      name: app.name,
      flyAppName: app.flyAppName,
      machines: machines.map((m) => ({
        id: m.id,
        state: m.state as "creating" | "running" | "frozen" | "failed",
        size: m.size as "shared-cpu-1x" | "shared-cpu-2x" | "shared-cpu-4x",
        region: m.region,
        privateIp: m.privateIp,
      })),
    });
  }

  out.blank();

  const rows = instances.map((instance) => {
    const summary = getInstanceStateSummary(instance);
    const stateStr = formatInstanceState(summary);
    const type = summary.total === 1 ? "browser" : `pool (${summary.total})`;
    const endpoint = getCdpEndpoint(instance.flyAppName, network);
    return [instance.name, type, stateStr, endpoint];
  });

  const table = new Table()
    .header(["Name", "Type", "State", "Endpoint"])
    .body(rows)
    .indent(2)
    .padding(2);

  out.text(table.toString());
  out.blank();

  out.done({ instances });
  out.print();
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "list",
  description: "List all browsers and pools on a network",
  usage: "chromatic list [--network NAME] [--org ORG] [--json]",
  run: list,
});
