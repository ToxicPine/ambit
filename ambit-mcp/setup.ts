#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// =============================================================================
// ambit-mcp setup — register the MCP server with your editor or project
// =============================================================================

import { parseArgs } from "@std/cli";
import { dirname, join, resolve } from "@std/path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EditorId = "claude" | "cursor" | "windsurf" | "vscode" | "claude-desktop";

interface McpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
}

/** Each editor knows its config path, JSON key, and how to shape entries. */
interface Editor {
  label: string;
  configDir: string;
  configPath: string;
  serversKey: "mcpServers" | "servers";
  transformEntry: (entry: McpEntry) => McpEntry;
}

/** Resolved write target — carries editor-specific details through the flow. */
interface Target {
  path: string;
  scope: "user" | "project";
  label: string;
  serversKey: "mcpServers" | "servers";
  transformEntry: (entry: McpEntry) => McpEntry;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
const DEFAULT_FLAKE_REF = "github:ToxicPine/ambit#ambit-mcp";
const MCP_FILENAME = ".mcp.json";

const identity = (e: McpEntry): McpEntry => e;

/** VS Code requires `type: "stdio"` on every stdio server entry. */
const addStdioType = (e: McpEntry): McpEntry => ({ type: "stdio", ...e });

// Editor registry — paths and formats sourced from official docs:
//   Claude Code:    https://code.claude.com/docs/en/mcp
//   Cursor:         https://cursor.com/docs/context/mcp
//   Windsurf:       https://docs.windsurf.com/windsurf/cascade/mcp
//   VS Code:        https://code.visualstudio.com/docs/copilot/chat/mcp-servers
//   Claude Desktop: https://modelcontextprotocol.io/quickstart/user

const EDITORS: Record<EditorId, Editor> = {
  "claude": {
    label: "Claude Code",
    configDir: join(HOME, ".claude"),
    configPath: join(HOME, ".claude.json"),
    serversKey: "mcpServers",
    transformEntry: identity,
  },
  "cursor": {
    label: "Cursor",
    configDir: join(HOME, ".cursor"),
    configPath: join(HOME, ".cursor", "mcp.json"),
    serversKey: "mcpServers",
    transformEntry: identity,
  },
  "windsurf": {
    label: "Windsurf",
    configDir: join(HOME, ".codeium", "windsurf"),
    configPath: join(HOME, ".codeium", "windsurf", "mcp_config.json"),
    serversKey: "mcpServers",
    transformEntry: identity,
  },
  "vscode": {
    label: "VS Code",
    configDir: join(HOME, ".config", "Code"),
    configPath: join(HOME, ".config", "Code", "User", "mcp.json"),
    serversKey: "servers",
    transformEntry: addStdioType,
  },
  "claude-desktop": {
    label: "Claude Desktop",
    configDir: join(HOME, ".config", "Claude"),
    configPath: join(HOME, ".config", "Claude", "claude_desktop_config.json"),
    serversKey: "mcpServers",
    transformEntry: identity,
  },
};

const EDITOR_IDS = Object.keys(EDITORS) as EditorId[];

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function tildeify(p: string): string {
  return HOME && p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
}

function formatEntry(name: string, entry: McpEntry): string {
  return JSON.stringify({ [name]: entry }, null, 2)
    .split("\n").slice(1, -1) // strip outer braces
    .map((l) => l.slice(2)) // un-indent one level
    .join("\n");
}

async function confirm(message: string): Promise<boolean> {
  const buf = new Uint8Array(64);
  Deno.stdout.writeSync(new TextEncoder().encode(`${message} [y/N] `));
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;
  return new TextDecoder()
    .decode(buf.subarray(0, n)).trim().toLowerCase().startsWith("y");
}

function die(msg: string): never {
  console.error(`  ${red(msg)}`);
  Deno.exit(1);
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

async function pathExists(
  path: string,
  kind: "file" | "dir",
): Promise<boolean> {
  try {
    const s = await Deno.stat(path);
    return kind === "file" ? s.isFile : s.isDirectory;
  } catch {
    return false;
  }
}

async function findUp(filename: string): Promise<string | null> {
  let dir = resolve(Deno.cwd());
  const root = Deno.build.os === "windows" ? dir.split(":")[0] + ":\\" : "/";
  while (dir !== root) {
    const candidate = join(dir, filename);
    if (await pathExists(candidate, "file")) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

/** Read a JSON file. Returns {} on not-found. Exits on parse error. */
async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const text = await Deno.readTextFile(path);
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) return parsed;
    return {};
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return {};
    if (e instanceof SyntaxError) die(`Invalid JSON in ${tildeify(path)}`);
    throw e;
  }
}

/** Write JSON atomically: write to .tmp sibling, then rename. */
async function writeJsonAtomic(
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await Deno.writeTextFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await Deno.rename(tmp, path);
}

/**
 * Safely upsert an MCP server entry into a JSON config file.
 *
 * Reads the full file, sets `config[serversKey][name] = entry`, and writes
 * back atomically — preserving every other key in the file. This is safe for
 * shared config files like Claude Code's ~/.claude.json and Claude Desktop's
 * claude_desktop_config.json, as well as standalone MCP config files.
 */
async function upsertServer(
  path: string,
  serversKey: string,
  name: string,
  entry: McpEntry,
): Promise<void> {
  const config = await readJson(path);
  const servers = (config[serversKey] ?? {}) as Record<string, unknown>;
  servers[name] = entry;
  config[serversKey] = servers;
  await writeJsonAtomic(path, config);
}

// ---------------------------------------------------------------------------
// Editor Detection
// ---------------------------------------------------------------------------

async function detectEditors(): Promise<EditorId[]> {
  const found: EditorId[] = [];
  for (const id of EDITOR_IDS) {
    if (await pathExists(EDITORS[id].configDir, "dir")) found.push(id);
  }
  return found;
}

async function promptEditorChoice(editors: EditorId[]): Promise<EditorId> {
  console.log(`  ${bold("Multiple Editors Detected:")}`);
  console.log();
  for (let i = 0; i < editors.length; i++) {
    console.log(`    ${cyan(String(i + 1))}  ${EDITORS[editors[i]].label}`);
  }
  console.log();

  const buf = new Uint8Array(64);
  Deno.stdout.writeSync(
    new TextEncoder().encode(`  Choose [1-${editors.length}]: `),
  );
  const n = await Deno.stdin.read(buf);
  if (n === null) Deno.exit(1);

  const choice = parseInt(
    new TextDecoder().decode(buf.subarray(0, n)).trim(),
    10,
  );
  if (isNaN(choice) || choice < 1 || choice > editors.length) {
    die("Invalid Choice.");
  }
  return editors[choice - 1];
}

// ---------------------------------------------------------------------------
// Target Resolution
// ---------------------------------------------------------------------------

async function resolveTarget(args: {
  project?: boolean;
  create?: boolean;
  editor?: string;
  yes?: boolean;
  json?: boolean;
}): Promise<Target> {
  // --- Project mode: find or create .mcp.json ---
  if (args.project) {
    const found = await findUp(MCP_FILENAME);
    if (found) {
      return {
        path: found,
        scope: "project",
        label: "Project",
        serversKey: "mcpServers",
        transformEntry: identity,
      };
    }
    if (!args.create) {
      if (args.json) {
        console.log(JSON.stringify({ error: `No ${MCP_FILENAME} Found` }));
      } else {
        console.log(
          `  ${dim(`No ${MCP_FILENAME} found in parent directories.`)}`,
        );
        console.log(`  Use ${cyan("--create")} to Create One Here.`);
        console.log();
      }
      Deno.exit(1);
    }
    return {
      path: join(Deno.cwd(), MCP_FILENAME),
      scope: "project",
      label: "Project",
      serversKey: "mcpServers",
      transformEntry: identity,
    };
  }

  // --- User mode: auto-detect or use --editor ---
  let editorId: EditorId;

  if (args.editor) {
    editorId = args.editor as EditorId;
  } else {
    const detected = await detectEditors();
    if (detected.length === 0) {
      if (args.json) {
        console.log(
          JSON.stringify({ error: "No Supported Editors Detected" }),
        );
      } else {
        console.error(`  ${red("No Supported Editors Detected.")}`);
        console.error(
          `  ${dim("Use --editor to specify one, or --project for .mcp.json")}`,
        );
      }
      Deno.exit(1);
    }
    editorId = detected.length === 1
      ? detected[0]
      : (args.yes || args.json)
      ? detected[0]
      : await promptEditorChoice(detected);
  }

  const editor = EDITORS[editorId];
  return {
    path: editor.configPath,
    scope: "user",
    label: editor.label,
    serversKey: editor.serversKey,
    transformEntry: editor.transformEntry,
  };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
${bold("ambit-mcp Setup")} — Add ambit MCP Server to Your Editor

${bold("USAGE")}
  ambit-mcp setup [options]

${bold("OPTIONS")}
  -n, --name <name>      Server Name ${dim("(default: ambit)")}
  --editor <editor>      Target Editor ${dim("(default: auto-detect)")}
  --project              Write to Project ${MCP_FILENAME} Instead
  --create               Create ${MCP_FILENAME} if Not Found ${
    dim("(with --project)")
  }
  --unsafe               Configure for Unsafe Mode ${dim("(default: safe)")}
  --dry-run              Preview Changes Without Writing
  --flake <ref>          Flake Reference ${
    dim(`(default: ${DEFAULT_FLAKE_REF})`)
  }
  -y, --yes              Skip Confirmation Prompts
  --json                 Output as JSON
  --help                 Show This Help

${bold("EDITORS")}
  claude                 Claude Code ${dim(tildeify(EDITORS.claude.configPath))}
  cursor                 Cursor ${dim(tildeify(EDITORS.cursor.configPath))}
  windsurf               Windsurf ${dim(tildeify(EDITORS.windsurf.configPath))}
  vscode                 VS Code ${dim(tildeify(EDITORS.vscode.configPath))}
  claude-desktop         Claude Desktop ${
    dim(tildeify(EDITORS["claude-desktop"].configPath))
  }

${bold("EXAMPLES")}
  ambit-mcp setup                          ${
    dim("# user-level, auto-detect editor")
  }
  ambit-mcp setup --editor cursor          ${dim("# user-level, Cursor")}
  ambit-mcp setup --project --create       ${dim("# project-level .mcp.json")}
  ambit-mcp setup --unsafe --name fly-raw  ${dim("# unsafe mode, custom name")}
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["name", "flake", "editor"],
    boolean: ["help", "unsafe", "project", "create", "dry-run", "yes", "json"],
    alias: { n: "name", y: "yes" },
  });

  if (args.help) {
    printHelp();
    return;
  }

  // --- Validate flags ---

  if (args.editor && !EDITOR_IDS.includes(args.editor as EditorId)) {
    const valid = EDITOR_IDS.join(", ");
    if (args.json) {
      console.log(
        JSON.stringify({ error: `Unknown Editor: ${args.editor}`, valid }),
      );
    } else {
      console.error(`  ${red("Unknown Editor:")} ${args.editor}`);
      console.error(`  ${dim(`Valid: ${valid}`)}`);
    }
    Deno.exit(1);
  }

  if (args.project && args.editor) {
    const msg = "--project and --editor Are Mutually Exclusive";
    if (args.json) console.log(JSON.stringify({ error: msg }));
    else die(msg);
  }

  if (args.create && !args.project) {
    const msg = "--create Requires --project";
    if (args.json) console.log(JSON.stringify({ error: msg }));
    else die(msg);
  }

  // --- Build server entry ---

  const serverName = args.name ?? "ambit";
  const unsafe = args.unsafe ?? false;
  const flakeRef = args.flake ?? DEFAULT_FLAKE_REF;

  const target = await resolveTarget(args);
  const entry = target.transformEntry({
    command: "nix",
    args: unsafe ? ["run", flakeRef, "--", "--unsafe"] : ["run", flakeRef],
  });

  // --- Display header ---

  if (!args.json) {
    console.log();
    console.log(`  ${bold("ambit-mcp Setup")}`);
    console.log();
    console.log(`  Mode:   ${unsafe ? yellow("Unsafe") : green("Safe")}`);
    console.log(`  Server: ${cyan(serverName)}`);
    console.log(
      `  Scope:  ${
        target.scope === "user" ? cyan(target.label) : cyan("Project")
      }`,
    );
    console.log(`  Target: ${dim(tildeify(target.path))}`);
    console.log(`  Flake:  ${dim(flakeRef)}`);
    console.log();
  }

  // --- Inspect existing config ---

  const fileIsNew = !(await pathExists(target.path, "file"));

  if (!fileIsNew) {
    const config = await readJson(target.path);
    const servers = (config[target.serversKey] ?? {}) as Record<
      string,
      unknown
    >;
    const names = Object.keys(servers);

    if (!args.json) {
      console.log(`  ${green("\u2713")} Found ${tildeify(target.path)}`);
      if (names.length > 0) {
        console.log(`  Existing: ${names.map((s) => cyan(s)).join(", ")}`);
      }
    }

    if (servers[serverName]) {
      if (!args.json) {
        console.log(
          `\n  ${yellow("!")} Server '${serverName}' Already Exists.`,
        );
      }
      if (!args.yes && !args.json) {
        if (!(await confirm("  Overwrite?"))) {
          console.log("  Cancelled.");
          return;
        }
      }
    }
  } else if (!args.json) {
    console.log(`  ${green("+")} Creating ${tildeify(target.path)}`);
  }

  // --- Preview ---

  if (!args.json) {
    console.log();
    console.log(`  ${bold("Server Config:")}`);
    console.log();
    for (const line of formatEntry(serverName, entry).split("\n")) {
      console.log(`    ${dim(line)}`);
    }
    console.log();
  }

  if (args["dry-run"]) {
    if (args.json) {
      console.log(JSON.stringify({
        dryRun: true,
        scope: target.scope,
        editor: target.label,
        serverName,
        server: entry,
        targetPath: target.path,
      }));
    } else {
      console.log(`  ${dim("Dry run \u2014 no changes written.")}`);
      console.log();
    }
    return;
  }

  // --- Confirm & write ---

  if (!args.yes && !args.json) {
    if (!(await confirm("  Write Changes?"))) {
      console.log("  Cancelled.");
      return;
    }
  }

  try {
    await upsertServer(target.path, target.serversKey, serverName, entry);
  } catch (e) {
    if (e instanceof Deno.errors.PermissionDenied) {
      die(`Permission Denied Writing ${tildeify(target.path)}`);
    }
    throw e;
  }

  // --- Result ---

  if (args.json) {
    console.log(JSON.stringify({
      written: true,
      scope: target.scope,
      editor: target.label,
      serverName,
      server: entry,
      targetPath: target.path,
    }));
  } else {
    console.log();
    console.log(
      `  ${green("\u2713")} Added ${cyan(serverName)} to ${
        tildeify(target.path)
      }`,
    );
    console.log();
  }
}

if (import.meta.main) {
  await main();
}
