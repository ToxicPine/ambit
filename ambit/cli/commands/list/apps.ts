// =============================================================================
// List Apps — List All Workload Apps on a Network
// =============================================================================

import { parseArgs } from "@std/cli";
import { Table } from "@cliffy/table";
import { bold } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput } from "@/lib/output.ts";
import {
  findRouterApp,
  listWorkloadAppsOnNetwork,
} from "@/util/discovery.ts";
import { initSession } from "@/util/session.ts";
import type { FlyAppStatus } from "@/schemas/fly.ts";

// =============================================================================
// Types
// =============================================================================

type ListAppsResult = {
  network: string;
  apps: Array<{
    appName: string;
    status: FlyAppStatus;
  }>;
};

// =============================================================================
// List Apps Command
// =============================================================================

export const listApps = async (argv: string[]): Promise<void> => {
  const opts = { string: ["org"], boolean: ["help", "json"] } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit list apps");

  if (args.help) {
    console.log(`
${bold("ambit list apps")} - List Apps on a Network

${bold("USAGE")}
  ambit list apps <network> [--org <org>] [--json]

${bold("OPTIONS")}
  --org <org>   Fly.io organization slug
  --json        Output as JSON

${bold("EXAMPLES")}
  ambit list apps browsers
  ambit list apps browsers --json
`);
    return;
  }

  const out = createOutput<ListAppsResult>(args.json);

  const network = typeof args._[0] === "string" ? args._[0] : undefined;
  if (!network) {
    return out.die("Missing Network Name. Usage: ambit list apps <network>");
  }

  const { fly, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  const router = await findRouterApp(fly, org, network);
  if (!router) {
    return out.die(`No Network Found: '${network}'`);
  }

  const workloads = await listWorkloadAppsOnNetwork(fly, org, network);

  if (workloads.length === 0) {
    out.blank()
      .text(`No Apps Found on Network '${network}'.`)
      .dim("  Deploy one with: ambit deploy <app>.<network>")
      .blank();
    out.done({ network, apps: [] });
    out.print();
    return;
  }

  out.blank().header(`Apps on '${network}'`).blank();

  const rows = workloads.map((w) => [w.appName, w.status]);

  const table = new Table()
    .header(["App", "Status"])
    .body(rows)
    .indent(2)
    .padding(2);

  out.text(table.toString());
  out.blank();
  out.done({
    network,
    apps: workloads.map((w) => ({ appName: w.appName, status: w.status })),
  });
  out.print();
};
