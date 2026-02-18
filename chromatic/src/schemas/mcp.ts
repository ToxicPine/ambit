// =============================================================================
// MCP Configuration Schema
// =============================================================================

import { z } from "zod";

// =============================================================================
// MCP Server Schema
// =============================================================================

export const McpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type McpServer = z.infer<typeof McpServerSchema>;

// =============================================================================
// MCP Config Schema
// =============================================================================

export const McpConfigSchema = z.object({
  mcpServers: z.record(z.string(), McpServerSchema).optional(),
}).passthrough();

export type McpConfig = z.infer<typeof McpConfigSchema>;

// =============================================================================
// Create Playwright MCP Server Config
// =============================================================================

export const createPlaywrightMcpServer = (cdpEndpoint: string): McpServer => ({
  command: "npx",
  args: [
    "@playwright/mcp@latest",
    "--cdp-endpoint",
    cdpEndpoint,
  ],
});

// =============================================================================
// Merge MCP Config
// =============================================================================

export const mergeMcpConfig = (
  existing: McpConfig,
  serverName: string,
  server: McpServer
): McpConfig => {
  return {
    ...existing,
    mcpServers: {
      ...existing.mcpServers,
      [serverName]: server,
    },
  };
};

// =============================================================================
// Check if Server Exists
// =============================================================================

export const hasServer = (config: McpConfig, serverName: string): boolean => {
  return !!config.mcpServers?.[serverName];
};

// =============================================================================
// List Existing Servers
// =============================================================================

export const listServers = (config: McpConfig): string[] => {
  return Object.keys(config.mcpServers ?? {});
};

// =============================================================================
// Format Server Config for Display
// =============================================================================

export const formatServerConfig = (name: string, server: McpServer): string => {
  const lines = [
    `"${name}": {`,
    `  "command": "${server.command}",`,
  ];

  if (server.args && server.args.length > 0) {
    lines.push(`  "args": [`);
    server.args.forEach((arg, i) => {
      const comma = i < server.args!.length - 1 ? "," : "";
      lines.push(`    "${arg}"${comma}`);
    });
    lines.push(`  ]`);
  }

  lines.push(`}`);

  return lines.join("\n");
};
