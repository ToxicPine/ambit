// =============================================================================
// List Command - List All Discovered Routers
// =============================================================================

import { parseArgs } from "@std/cli";
import { Table } from "@cliffy/table";
import { bold } from "@/lib/cli.ts";
import { createOutput } from "@/lib/output.ts";
import { registerCommand } from "../mod.ts";
import { createFlyProvider } from "@/src/providers/fly.ts";
import { createTailscaleProvider } from "@/src/providers/tailscale.ts";
import { checkDependencies } from "@/src/credentials.ts";
import {
  getRouterMachineInfo,
  getRouterTailscaleInfo,
  listRouterApps,
  type RouterApp,
  type RouterMachineInfo,
  type RouterTailscaleInfo,
} from "@/src/discovery.ts";
import { resolveOrg } from "@/src/resolve.ts";

// =============================================================================
// List Command
// =============================================================================

const list = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["org"],
    boolean: ["help", "json"],
  });

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

  const out = createOutput<{
    routers: (RouterApp & {
      machine: RouterMachineInfo | null;
      tailscale: RouterTailscaleInfo | null;
    })[];
  }>(args.json);

  // =========================================================================
  // Prerequisites
  // =========================================================================

  const { tailscaleKey } = await checkDependencies(out);

  const fly = createFlyProvider();
  await fly.ensureAuth({ interactive: !args.json });
  const tailscale = createTailscaleProvider("-", tailscaleKey);
  const org = await resolveOrg(fly, args, out);

  // =========================================================================
  // Discover Routers
  // =========================================================================

  const spinner = out.spinner("Discovering Routers");
  const routerApps = await listRouterApps(fly, org);
  spinner.success(
    `Found ${routerApps.length} Router${routerApps.length !== 1 ? "s" : ""}`,
  );

  if (routerApps.length === 0) {
    out.blank()
      .text("No Routers Found.")
      .dim("  Create one with: ambit create <network>")
      .blank();

    out.done({ routers: [] });
    out.print();
    return;
  }

  const routers: (RouterApp & {
    machine: RouterMachineInfo | null;
    tailscale: RouterTailscaleInfo | null;
  })[] = [];

  for (const app of routerApps) {
    const machine = await getRouterMachineInfo(fly, app.appName);
    const ts = await getRouterTailscaleInfo(tailscale, app.appName);
    routers.push({ ...app, machine, tailscale: ts });
  }

  // =========================================================================
  // Render
  // =========================================================================

  out.blank().header("Routers").blank();

  const rows = routers.map((r) => {
    const tsStatus = r.tailscale
      ? r.tailscale.online ? "online" : "offline"
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
// Register Command
// =============================================================================

registerCommand({
  name: "list",
  description: "List all discovered routers across networks",
  usage: "ambit list [--org <org>] [--json]",
  run: list,
});
