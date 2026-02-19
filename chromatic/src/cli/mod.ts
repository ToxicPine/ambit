// =============================================================================
// CLI Framework - Command Parser and Router
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, die, dim } from "@cardelli/ambit/lib/cli";

// =============================================================================
// Command Interface
// =============================================================================

export interface Command {
  name: string;
  description: string;
  usage: string;
  run: (args: string[]) => Promise<void>;
}

// =============================================================================
// Commands Registry
// =============================================================================

const commands: Map<string, Command> = new Map();

export const registerCommand = (command: Command): void => {
  commands.set(command.name, command);
};

export const getCommand = (name: string): Command | undefined => {
  return commands.get(name);
};

export const getAllCommands = (): Command[] => {
  return Array.from(commands.values());
};

// =============================================================================
// Help Text
// =============================================================================

const VERSION = "0.2.0";

export const showHelp = (): void => {
  console.log(`
${bold("chromatic")} - Remote Chrome Browsers on Fly.io + Tailscale

${bold("USAGE")}
  chromatic <command> [options]

${bold("COMMANDS")}
  setup      Discover routers and save network preference
  create     Create a browser (1 machine) or browser pool (N machines)
  list       List all browsers and pools on a network
  status     Show browser/pool details including machines and endpoints
  scale      Scale machines in a browser pool
  destroy    Delete a browser or pool and all its machines
  mcp        Add a browser to your .mcp.json for AI agents
  doctor     Check environment, credentials, and router health

${bold("OPTIONS")}
  --help     Show help for a command
  --version  Show version
  --org      Fly.io organization (auto-detected if only one)
  --network  Custom network name (default: browsers)

${bold("EXAMPLES")}
  chromatic create my-browser
  chromatic create scrapers --count 3
  chromatic list
  chromatic status my-browser
  chromatic scale scrapers 5
  chromatic mcp my-browser
  chromatic destroy my-browser

${dim("Run 'chromatic <command> --help' for command-specific help.")}
`);
};

export const showVersion = (): void => {
  console.log(`chromatic ${VERSION}`);
};

// =============================================================================
// Main CLI Runner
// =============================================================================

export const runCli = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    boolean: ["help", "version"],
    stopEarly: true,
  });

  if (args.version) {
    showVersion();
    return;
  }

  const commandName = typeof args._[0] === "string" ? args._[0] : undefined;

  if (!commandName || args.help) {
    if (commandName) {
      const command = getCommand(commandName);
      if (command) {
        console.log(`
${bold(command.name)} - ${command.description}

${bold("USAGE")}
  ${command.usage}
`);
        return;
      }
    }
    showHelp();
    return;
  }

  const command = getCommand(commandName);
  if (!command) {
    console.log(`Unknown command: ${commandName}`);
    console.log(`Run 'chromatic --help' for usage.`);
    Deno.exit(1);
  }

  const commandArgs = argv.slice(1);
  await command.run(commandArgs);
};
