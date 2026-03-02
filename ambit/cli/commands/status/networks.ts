// =============================================================================
// Status Networks — Summary Table of All Networks
// =============================================================================

import { parseArgs } from "@std/cli";
import { Table } from "@cliffy/table";
import { bold } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput } from "@/lib/output.ts";
import { discoverRouters, type RouterWithInfo } from "@/util/discovery.ts";
import { initSession } from "@/util/session.ts";

// =============================================================================
// Status Networks Subcommand
// =============================================================================

export const statusNetworks = async (argv: string[]): Promise<void> => {
  const opts = { string: ["org"], boolean: ["help", "json"] } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit status networks");

  if (args.help) {
    console.log(`
${bold("ambit status networks")} - Show Status of All Networks

${bold("USAGE")}
  ambit status networks [--org <org>] [--json]

${bold("OPTIONS")}
  --org <org>        Fly.io organization slug
  --json             Output as JSON
`);
    return;
  }

  const out = createOutput<{ routers: RouterWithInfo[] }>(args.json);
  const { fly, tailscale, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  const routers = await discoverRouters(out, fly, tailscale, org);

  if (routers.length === 0) {
    out.blank()
      .text("No Networks Found.")
      .dim("  Create One with: ambit create <network>")
      .blank();
    out.done({ routers: [] });
    out.print();
    return;
  }

  out.blank().header("Network Status").blank();

  const rows = routers.map((r) => {
    const tsStatus = r.tailscale
      ? (r.tailscale.online ? "online" : "offline")
      : "not found";
    return [r.network, r.appName, r.status, tsStatus];
  });

  const table = new Table()
    .header(["Network", "App", "Status", "Tailscale"])
    .body(rows)
    .indent(2)
    .padding(2);

  out.text(table.toString());
  out.blank();
  out.done({ routers });
  out.print();
};
