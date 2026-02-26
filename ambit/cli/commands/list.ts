// =============================================================================
// List Command - List All Discovered Routers
// =============================================================================

import { parseArgs } from "@std/cli";
import { Table } from "@cliffy/table";
import { bold } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput, type Output } from "@/lib/output.ts";
import { registerCommand } from "@/cli/mod.ts";
import { discoverRouters, type RouterWithInfo } from "@/util/discovery.ts";
import { initSession } from "@/util/session.ts";

// =============================================================================
// Types
// =============================================================================

type ListResult = { routers: RouterWithInfo[] };

// =============================================================================
// Stage: Render
// =============================================================================

const stageRender = (
  out: Output<ListResult>,
  routers: RouterWithInfo[],
): void => {
  if (routers.length === 0) {
    out.blank()
      .text("No Routers Found.")
      .dim("  Create one with: ambit create <network>")
      .blank();
    out.done({ routers: [] });
    out.print();
    return;
  }

  out.blank().header("Routers").blank();

  const rows = routers.map((r) => {
    const tsStatus = r.tailscale
      ? (r.tailscale.online ? "online" : "offline")
      : "not found";
    const tag = r.tailscale?.tags?.[0] ?? "unknown";
    return [
      r.network,
      r.appName,
      r.machine?.region ?? "-",
      r.machine?.state ?? "unknown",
      tsStatus,
      tag,
    ];
  });

  const table = new Table()
    .header(["Network", "App", "Region", "State", "Tailscale", "Tag"])
    .body(rows)
    .indent(2)
    .padding(2);

  out.text(table.toString());
  out.blank();
  out.done({ routers });
  out.print();
};

// =============================================================================
// List Command
// =============================================================================

const list = async (argv: string[]): Promise<void> => {
  const opts = { string: ["org"], boolean: ["help", "json"] } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit list");

  if (args.help) {
    console.log(`
${bold("ambit list")} - List All Discovered Routers

${bold("USAGE")}
  ambit list [--org <org>] [--json]

${bold("OPTIONS")}
  --org <org>   Fly.io organization slug
  --json        Output as JSON
`);
    return;
  }

  const out = createOutput<ListResult>(args.json);
  const { fly, tailscale, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  const routers = await discoverRouters(out, fly, tailscale, org);
  stageRender(out, routers);
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "list",
  description: "List all discovered routers across networks",
  usage: "ambit list [--org <org>] [--json]",
  run: list,
});
