// =============================================================================
// Destroy Command - Destroy Networks or Apps
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold } from "@/lib/cli.ts";
import { registerCommand } from "@/cli/mod.ts";
import { destroyNetwork } from "./network.ts";
import { destroyApp } from "./app.ts";

// =============================================================================
// Top-Level Help
// =============================================================================

const showDestroyHelp = (): void => {
  console.log(`
${bold("ambit destroy")} - Destroy Networks or Apps

${bold("USAGE")}
  ambit destroy network <name> [options]
  ambit destroy app <app>.<network> [options]

${bold("SUBCOMMANDS")}
  network    Tear down a router, clean up DNS and tailnet device
  app        Destroy a workload app on a network

${bold("OPTIONS")}
  --help     Show help for a subcommand

${bold("EXAMPLES")}
  ambit destroy network browsers
  ambit destroy app my-app.browsers
  ambit destroy app my-app --network browsers

Run 'ambit destroy network --help' or 'ambit destroy app --help' for details.
`);
};

// =============================================================================
// Dispatcher
// =============================================================================

const destroy = async (argv: string[]): Promise<void> => {
  const subcommand = typeof argv[0] === "string" ? argv[0] : undefined;

  if (subcommand === "network") {
    return destroyNetwork(argv.slice(1));
  }

  if (subcommand === "app") {
    return destroyApp(argv.slice(1));
  }

  const args = parseArgs(argv, { boolean: ["help"] });
  if (args.help) {
    showDestroyHelp();
    return;
  }

  showDestroyHelp();
  Deno.exit(1);
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "destroy",
  description: "Destroy a network (router) or a workload app",
  usage: "ambit destroy network|app <name> [options]",
  run: destroy,
});
