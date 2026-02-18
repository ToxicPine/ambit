import { parseArgs } from "@std/cli";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildTools, type Mode } from "./src/tools.ts";
import { createHandlers } from "./src/handlers.ts";

const args = parseArgs(Deno.args, {
  boolean: ["safe", "unsafe"],
  default: { safe: false, unsafe: false },
});

const mode: Mode = args.unsafe ? "unsafe" : "safe";

const server = new McpServer({
  name: `ambit-mcp (${mode})`,
  version: "0.1.0",
});

// --- Register tools ---

const tools = buildTools(mode);
const handlers = createHandlers(mode);

for (const [name, def] of Object.entries(tools)) {
  const handler = handlers[name];
  server.registerTool(name, {
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    annotations: def.annotations,
  }, async (args) => {
    if (!handler) {
      return { content: [{ type: "text" as const, text: `${name}: no handler registered` }], isError: true };
    }
    try {
      return await handler(args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  });
}

// --- Register resources ---

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { server, tools, mode };
