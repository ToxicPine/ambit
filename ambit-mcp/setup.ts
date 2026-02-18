#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// =============================================================================
// ambit-mcp setup — add the MCP server to .mcp.json
// =============================================================================
// Usage:
//   nix run .#setup                       # safe mode, find .mcp.json upward
//   nix run .#setup -- --unsafe           # unsafe mode
//   nix run .#setup -- --create           # create .mcp.json if not found
//   nix run .#setup -- --name my-server   # custom server name
//   nix run .#setup -- --yes              # skip confirmation
//   nix run .#setup -- --dry-run          # preview without writing
//   nix run .#setup -- --flake /path      # custom flake path
// =============================================================================

import { parseArgs } from "@std/cli";
import { resolve, dirname, join } from "@std/path";

// =============================================================================
// Types
// =============================================================================

interface McpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers?: Record<string, McpServer>;
  [key: string]: unknown;
}

// =============================================================================
// File Finder
// =============================================================================

const MCP_FILENAME = ".mcp.json";

async function findFileUp(filename: string): Promise<string | null> {
  let current = resolve(Deno.cwd());
  const root = Deno.build.os === "windows" ? current.split(":")[0] + ":\\" : "/";

  while (current !== root) {
    const candidate = join(current, filename);
    try {
      const stat = await Deno.stat(candidate);
      if (stat.isFile) return candidate;
    } catch { /* continue */ }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function relativePath(absolutePath: string): string {
  const base = resolve(Deno.cwd());
  if (absolutePath.startsWith(base)) {
    const rel = absolutePath.slice(base.length);
    return rel === "" ? "." : rel.startsWith("/") ? "." + rel : "./" + rel;
  }
  return absolutePath;
}

// =============================================================================
// Display Helpers
// =============================================================================

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function formatServer(name: string, server: McpServer): string {
  const lines = [`"${name}": {`, `  "command": "${server.command}",`];
  if (server.args?.length) {
    lines.push(`  "args": [`);
    server.args.forEach((arg, i) => {
      const comma = i < server.args!.length - 1 ? "," : "";
      lines.push(`    "${arg}"${comma}`);
    });
    lines.push(`  ]`);
  }
  lines.push(`}`);
  return lines.join("\n");
}

async function confirm(message: string): Promise<boolean> {
  const buf = new Uint8Array(64);
  Deno.stdout.writeSync(new TextEncoder().encode(`${message} [y/N] `));
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;
  const answer = new TextDecoder().decode(buf.subarray(0, n)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// =============================================================================
// Resolve Flake Path
// =============================================================================

function resolveFlakePath(override?: string): string {
  if (override) return resolve(override);

  // If running as compiled binary, the flake is adjacent to the binary.
  // If running as a deno script, use the script's directory.
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  return resolve(scriptDir);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["name", "flake"],
    boolean: ["help", "unsafe", "create", "dry-run", "yes", "json"],
    alias: { n: "name", y: "yes" },
  });

  if (args.help) {
    console.log(`
${bold("ambit-mcp Setup")} — Add ambit MCP Server to ${MCP_FILENAME}

${bold("USAGE")}
  nix run .#setup [options]

${bold("OPTIONS")}
  -n, --name <server>   Server Name in Config ${dim("(default: ambit)")}
  --unsafe              Configure for Unsafe Mode ${dim("(default: safe)")}
  --create              Create ${MCP_FILENAME} if Not Found
  --dry-run             Preview Changes Without Writing
  --flake <path>        Path to the ambit-mcp Flake ${dim("(default: auto-detect)")}
  -y, --yes             Skip Confirmation Prompts
  --json                Output as JSON
  --help                Show This Help

${bold("EXAMPLES")}
  nix run .#setup
  nix run .#setup -- --unsafe --name fly-unsafe
  nix run .#setup -- --create --yes
  nix run .#setup -- --dry-run
`);
    return;
  }

  const serverName = args.name ?? "ambit";
  const unsafe = args.unsafe ?? false;
  const flakePath = resolveFlakePath(args.flake);

  // Build the MCP server config entry
  const serverConfig: McpServer = {
    command: "nix",
    args: unsafe
      ? ["run", flakePath, "--", "--unsafe"]
      : ["run", flakePath],
  };

  if (!args.json) {
    console.log();
    console.log(`  ${bold("ambit-mcp Setup")}`);
    console.log();
    console.log(`  Mode:   ${unsafe ? yellow("Unsafe") : green("Safe")}`);
    console.log(`  Server: ${cyan(serverName)}`);
    console.log(`  Flake:  ${dim(flakePath)}`);
    console.log();
  }

  // Find .mcp.json
  const foundPath = await findFileUp(MCP_FILENAME);

  let targetPath: string;
  let existingConfig: McpConfig = { mcpServers: {} };
  let isNewFile = false;

  if (!foundPath) {
    if (!args.create) {
      if (args.json) {
        console.log(JSON.stringify({ error: `No ${MCP_FILENAME} Found` }));
      } else {
        console.log(`  ${dim(`No ${MCP_FILENAME} Found in Parent Directories.`)}`);
        console.log(`  Use ${cyan("--create")} to Create One Here.`);
        console.log();
      }
      Deno.exit(1);
    }
    targetPath = join(Deno.cwd(), MCP_FILENAME);
    isNewFile = true;
    if (!args.json) {
      console.log(`  ${green("+")} Creating ${MCP_FILENAME}`);
    }
  } else {
    targetPath = foundPath;
    if (!args.json) {
      console.log(`  ${green("✓")} Found ${relativePath(targetPath)}`);
    }
  }

  // Parse existing
  if (!isNewFile) {
    try {
      const content = await Deno.readTextFile(targetPath);
      existingConfig = JSON.parse(content);
      if (typeof existingConfig !== "object" || existingConfig === null) {
        existingConfig = { mcpServers: {} };
      }
      if (!existingConfig.mcpServers) {
        existingConfig.mcpServers = {};
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.error(`  ${red("Error:")} Invalid JSON in ${relativePath(targetPath)}`);
        Deno.exit(1);
      }
      throw error;
    }
  }

  // Show existing servers
  const existing = Object.keys(existingConfig.mcpServers ?? {});
  if (existing.length > 0 && !args.json) {
    console.log(`  Existing: ${existing.map((s) => cyan(s)).join(", ")}`);
  }

  // Check conflict
  if (existingConfig.mcpServers?.[serverName]) {
    if (!args.json) {
      console.log();
      console.log(`  ${yellow("!")} Server '${serverName}' Already Exists.`);
    }
    if (!args.yes && !args.json) {
      const overwrite = await confirm("  Overwrite?");
      if (!overwrite) {
        console.log("  Cancelled.");
        return;
      }
    }
  }

  // Build new config
  const newConfig: McpConfig = {
    ...existingConfig,
    mcpServers: {
      ...existingConfig.mcpServers,
      [serverName]: serverConfig,
    },
  };

  // Preview
  if (!args.json) {
    console.log();
    console.log(`  ${bold("Server Config:")}`);
    console.log();
    for (const line of formatServer(serverName, serverConfig).split("\n")) {
      console.log(`    ${dim(line)}`);
    }
    console.log();
  }

  if (args["dry-run"]) {
    if (args.json) {
      console.log(JSON.stringify({
        dryRun: true,
        serverName,
        server: serverConfig,
        targetPath,
      }));
    } else {
      console.log(`  ${dim("Dry Run — No Changes Written.")}`);
      console.log();
    }
    return;
  }

  // Confirm
  if (!args.yes && !args.json) {
    const shouldWrite = await confirm("  Write Changes?");
    if (!shouldWrite) {
      console.log("  Cancelled.");
      return;
    }
  }

  // Write
  try {
    await Deno.writeTextFile(targetPath, JSON.stringify(newConfig, null, 2) + "\n");
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      console.error(`  ${red("Error:")} Permission Denied Writing ${relativePath(targetPath)}`);
      Deno.exit(1);
    }
    throw error;
  }

  if (args.json) {
    console.log(JSON.stringify({
      written: true,
      serverName,
      server: serverConfig,
      targetPath,
    }));
  } else {
    console.log();
    console.log(`  ${green("✓")} Added ${cyan(serverName)} to ${relativePath(targetPath)}`);
    console.log();
  }
}

if (import.meta.main) {
  await main();
}
