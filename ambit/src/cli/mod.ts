// =============================================================================
// CLI Framework - Command Parser and Router
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, dim, die } from "../../lib/cli.ts";

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

const VERSION = "0.3.0";

export const showHelp = (): void => {
  console.log(`
${bold("ambit")} - Tailscale Subnet Router for Fly.io Custom Networks

${bold("USAGE")}
  ambit <command> [options]

${bold("COMMANDS")}
  create     Create a Tailscale subnet router on a Fly.io custom network
  deploy     Deploy an app safely on a custom private network
  list       List all discovered routers across networks
  status     Show router status, network, and tailnet info
  destroy    Tear down the router, clean up DNS and tailnet device
  doctor     Check that Tailscale and the router are working correctly

${bold("OPTIONS")}
  --help     Show help for a command
  --version  Show version

${bold("EXAMPLES")}
  ambit create browsers
  ambit list
  ambit status --network browsers
  ambit destroy --network browsers
  ambit doctor

${dim("Run 'ambit <command> --help' for command-specific help.")}
`);
};

export const showVersion = (): void => {
  console.log(`ambit ${VERSION}`);
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

  const commandName = args._[0] as string | undefined;

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
    console.log(`Run 'ambit --help' for usage.`);
    Deno.exit(1);
  }

  const commandArgs = argv.slice(1);
  await command.run(commandArgs);
};
