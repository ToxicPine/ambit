// =============================================================================
// List Command - List Networks or Apps
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold } from "@/lib/cli.ts";
import { registerCommand } from "@/cli/mod.ts";
import { listNetworks } from "./networks.ts";
import { listApps } from "./apps.ts";

// =============================================================================
// Top-Level Help
// =============================================================================

const showListHelp = (): void => {
  console.log(`
${bold("ambit list")} - List Networks or Apps

${bold("USAGE")}
  ambit list networks [options]
  ambit list apps <network> [options]

${bold("SUBCOMMANDS")}
  networks   List all networks and their routers
  apps       List workload apps on a specific network

${bold("OPTIONS")}
  --org <org>   Fly.io organization slug
  --json        Output as JSON

${bold("EXAMPLES")}
  ambit list networks
  ambit list apps browsers
  ambit list apps browsers --json

Run 'ambit list networks --help' or 'ambit list apps --help' for details.
`);
};

// =============================================================================
// Dispatcher
// =============================================================================

const list = async (argv: string[]): Promise<void> => {
  const subcommand = typeof argv[0] === "string" ? argv[0] : undefined;

  if (subcommand === "networks") return listNetworks(argv.slice(1));
  if (subcommand === "apps") return listApps(argv.slice(1));

  const args = parseArgs(argv, { boolean: ["help"] });
  if (args.help) {
    showListHelp();
    return;
  }

  showListHelp();
  Deno.exit(1);
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "list",
  description: "List networks or apps",
  usage: "ambit list networks|apps [options]",
  run: list,
});
