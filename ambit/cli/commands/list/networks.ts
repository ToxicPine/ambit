// =============================================================================
// List Networks — List All Discovered Routers Across Networks
// =============================================================================

import { parseArgs } from "@std/cli";
import { Table } from "@cliffy/table";
import { bold } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput, type Output } from "@/lib/output.ts";
import { discoverRouters, type RouterWithInfo } from "@/util/discovery.ts";
import { initSession } from "@/util/session.ts";

// =============================================================================
// Types
// =============================================================================

type ListNetworksResult = { routers: RouterWithInfo[] };

// =============================================================================
// Stage: Render
// =============================================================================

const stageRender = (
  out: Output<ListNetworksResult>,
  routers: RouterWithInfo[],
): void => {
  if (routers.length === 0) {
    out.blank()
      .text("No Networks Found.")
      .dim("  Create one with: ambit create <network>")
      .blank();
    out.done({ routers: [] });
    out.print();
    return;
  }

  out.blank().header("Networks").blank();

  const rows = routers.map((r) => {
    const tsStatus = r.tailscale
      ? (r.tailscale.online ? "online" : "offline")
      : "not found";
    const tag = r.tailscale?.tags?.[0] ?? "unknown";
    return [
      r.network,
      r.appName,
      r.status,
      r.machine?.region ?? "-",
      tsStatus,
      tag,
    ];
  });

  const table = new Table()
    .header(["Network", "App", "Status", "Region", "Tailscale", "Tag"])
    .body(rows)
    .indent(2)
    .padding(2);

  out.text(table.toString());
  out.blank();
  out.done({ routers });
  out.print();
};

// =============================================================================
// List Networks Command
// =============================================================================

export const listNetworks = async (argv: string[]): Promise<void> => {
  const opts = { string: ["org"], boolean: ["help", "json"] } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit list networks");

  if (args.help) {
    console.log(`
${bold("ambit list networks")} - List All Networks

${bold("USAGE")}
  ambit list networks [--org <org>] [--json]

${bold("OPTIONS")}
  --org <org>   Fly.io organization slug
  --json        Output as JSON
`);
    return;
  }

  const out = createOutput<ListNetworksResult>(args.json);
  const { fly, tailscale, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  const routers = await discoverRouters(out, fly, tailscale, org);
  stageRender(out, routers);
};
