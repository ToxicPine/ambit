// =============================================================================
// Status Command - Show Network, App, and Router Status
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold } from "@/lib/cli.ts";
import { registerCommand } from "@/cli/mod.ts";
import { statusNetworks } from "./networks.ts";
import { statusNetwork } from "./network.ts";
import { statusApp } from "./app.ts";

// =============================================================================
// Top-Level Help
// =============================================================================

const showStatusHelp = (): void => {
  console.log(`
${bold("ambit status")} - Show Network, App, and Router Status

${bold("USAGE")}
  ambit status [options]
  ambit status networks [options]
  ambit status network <name> [options]
  ambit status app <app>.<network> [options]

${bold("SUBCOMMANDS")}
  networks   Show summary of all networks — default when no subcommand given
  network    Show detailed status for a specific network
  app        Show a specific app's status

${bold("OPTIONS")}
  --org <org>        Fly.io organization slug
  --json             Output as JSON

${bold("EXAMPLES")}
  ambit status
  ambit status networks
  ambit status network browsers
  ambit status app my-app.browsers

Run 'ambit status networks --help', 'ambit status network --help',
or 'ambit status app --help' for details.
`);
};

// =============================================================================
// Dispatcher
// =============================================================================

const status = async (argv: string[]): Promise<void> => {
  const subcommand = typeof argv[0] === "string" ? argv[0] : undefined;

  if (subcommand === "networks") return statusNetworks(argv.slice(1));
  if (subcommand === "network") return statusNetwork(argv.slice(1));
  if (subcommand === "app") return statusApp(argv.slice(1));

  const args = parseArgs(argv, { boolean: ["help"] });
  if (args.help) {
    showStatusHelp();
    return;
  }

  return statusNetworks(argv);
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "status",
  description: "Show network, app, and router status",
  usage: "ambit status [networks|network|app] [<name>] [--org <org>] [--json]",
  run: status,
});
