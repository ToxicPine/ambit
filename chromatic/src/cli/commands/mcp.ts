// =============================================================================
// MCP Command - Configure MCP with CDP Endpoint
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, confirm, cyan, dim } from "@cardelli/ambit/lib/cli";
import { createOutput } from "@cardelli/ambit/lib/output";
import { resolveOrg } from "@cardelli/ambit/src/resolve";
import { findFileUp, getRelativePath } from "../../../lib/find.ts";
import { registerCommand } from "../mod.ts";
import { loadConfig } from "../../schemas/config.ts";
import { findCdpApp, getCdpEndpoint } from "../../schemas/instance.ts";
import {
  createPlaywrightMcpServer,
  formatServerConfig,
  hasServer,
  listServers,
  type McpConfig,
  McpConfigSchema,
  mergeMcpConfig,
} from "../../schemas/mcp.ts";
import { createFlyProvider } from "@cardelli/ambit/providers/fly";

// =============================================================================
// Constants
// =============================================================================

const MCP_FILENAME = ".mcp.json";

// =============================================================================
// MCP Command
// =============================================================================

const mcp = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["name", "network", "org"],
    boolean: ["help", "create", "dry-run", "yes", "json"],
    alias: { n: "name", y: "yes" },
  });

  if (args.help) {
    console.log(`
${bold("chromatic mcp")} - Configure MCP with CDP Endpoint

${bold("USAGE")}
  chromatic mcp <name> [options]

${bold("OPTIONS")}
  -n, --name <server>   MCP server name in config (default: chromatic-<name>)
  --create              Create ${MCP_FILENAME} in current directory if not found
  --dry-run             Preview changes without writing
  --network <name>      Network name (default: from config)
  --org <org>           Fly.io organization slug
  -y, --yes             Skip confirmation prompts
  --json                Output as JSON

${bold("DESCRIPTION")}
  Adds a Playwright MCP server to your ${MCP_FILENAME}, configured with the
  CDP endpoint for the specified browser. If the browser is a pool with
  multiple machines, each MCP connection is load-balanced across them.

${bold("EXAMPLES")}
  chromatic mcp my-browser
  chromatic mcp scrapers --name browser-pool
  chromatic mcp my-browser --dry-run
  chromatic mcp my-browser --create --yes --json
`);
    return;
  }

  // deno-lint-ignore no-explicit-any
  const out = createOutput<any>(args.json);

  const instanceName = args._[0] as string | undefined;
  if (!instanceName) {
    return out.die("Instance Name Required");
  }

  const config = await loadConfig();
  const network = args.network ?? config.network;

  const fly = createFlyProvider();
  await fly.ensureInstalled();
  await fly.ensureAuth({ interactive: !args.json });

  const org = await resolveOrg(fly, args, out);

  const app = await findCdpApp(fly, org, network, instanceName);
  if (!app) {
    return out.die(`Instance '${instanceName}' Not Found`);
  }

  const cdpEndpoint = getCdpEndpoint(app.flyAppName, network);
  const serverName = args.name ?? `chromatic-${instanceName}`;

  out.blank()
    .info(`Instance: ${instanceName}`)
    .info(`Endpoint: ${cdpEndpoint}`)
    .blank();

  // Find .mcp.json in parent directories
  const foundPath = await findFileUp(MCP_FILENAME);

  let targetPath: string;
  let existingConfig: McpConfig = { mcpServers: {} };
  let isNewFile = false;

  if (!foundPath) {
    if (!args.create) {
      out.dim(`No ${MCP_FILENAME} Found in Parent Directories`)
        .blank()
        .text(
          `Use ${cyan("--create")} to create one in the current directory.`,
        );
      out.fail(`No ${MCP_FILENAME} Found`);
      out.print();
      return;
    }

    targetPath = `${Deno.cwd()}/${MCP_FILENAME}`;
    isNewFile = true;
    out.info(`Creating ${MCP_FILENAME}`);
  } else {
    targetPath = foundPath;
    out.ok(`Found: ${getRelativePath(targetPath)}`);
  }

  // Parse existing config
  if (!isNewFile) {
    try {
      const content = await Deno.readTextFile(targetPath);
      const parsed = JSON.parse(content);
      const validated = McpConfigSchema.safeParse(parsed);

      if (!validated.success) {
        return out.die(`Invalid MCP Config: ${validated.error.message}`);
      }

      existingConfig = validated.data;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return out.die(`Invalid JSON: ${error.message}`);
      }
      throw error;
    }
  }

  // Show existing servers
  const existingServers = listServers(existingConfig);
  if (existingServers.length > 0) {
    out.blank().text(
      `Existing Servers: ${existingServers.map((s) => cyan(s)).join(", ")}`,
    );
  }

  // Check for name conflict
  if (hasServer(existingConfig, serverName)) {
    out.blank().warn(`Server '${serverName}' Already Exists`);

    if (!args.yes && !out.isJson()) {
      const overwrite = await confirm("Overwrite?");
      if (!overwrite) {
        out.text("Cancelled.");
        out.print();
        return;
      }
    }
  }

  // Build new config
  const newServer = createPlaywrightMcpServer(cdpEndpoint);
  const newConfig = mergeMcpConfig(existingConfig, serverName, newServer);

  // Dry run or preview
  if (args["dry-run"]) {
    out.blank().header("Adding Server:").blank();
    const formatted = formatServerConfig(serverName, newServer);
    for (const line of formatted.split("\n")) {
      out.dim("  " + line);
    }
    out.blank().info("Dry Run Complete");
    out.done({ dryRun: true, serverName, server: newServer, targetPath });
    out.print();
    return;
  }

  out.blank().header("Adding Server:").blank();
  const formatted = formatServerConfig(serverName, newServer);
  for (const line of formatted.split("\n")) {
    out.dim("  " + line);
  }
  out.blank();

  // Confirm
  if (!args.yes && !out.isJson()) {
    const shouldWrite = await confirm("Write Changes?");
    if (!shouldWrite) {
      out.text("Cancelled.");
      out.print();
      return;
    }
  }

  // Write
  try {
    await Deno.writeTextFile(
      targetPath,
      JSON.stringify(newConfig, null, 2) + "\n",
    );
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      return out.die("Permission Denied");
    }
    throw error;
  }

  out.blank().ok(`Added ${cyan(serverName)} to ${getRelativePath(targetPath)}`);
  out.done({ written: true, serverName, server: newServer, targetPath });
  out.print();
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "mcp",
  description: "Add a browser to your .mcp.json for AI agents",
  usage:
    "chromatic mcp <name> [--name SERVER] [--create] [--network NAME] [--org ORG] [--yes]",
  run: mcp,
});
