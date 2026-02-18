#!/usr/bin/env -S deno run -A
// =============================================================================
// Chromatic CLI - CDP Instance Manager for Fly.io + Tailscale
// =============================================================================
//
// Usage:
//   deno run -A main.ts <command> [options]
//   chromatic <command> [options]
//
// Commands:
//   setup      Initialize Chromatic and deploy the subnet router
//   create     Create a new CDP instance
//   list       List all CDP instances
//   status     Show detailed instance status
//   scale      Scale machines in an instance
//   destroy    Remove an instance
//   mcp        Configure MCP with CDP endpoint
//   doctor     Verify environment and infrastructure health
//
// Examples:
//   chromatic setup
//   chromatic create my-browser
//   chromatic list
//   chromatic status my-browser
//   chromatic scale my-browser 3
//   chromatic destroy my-browser
//
// =============================================================================

import { runCli } from "./src/cli/mod.ts";
import { Spinner, statusErr } from "@cardelli/ambit/lib/cli";

// Import commands to register them
import "./src/cli/commands/setup.ts";
import "./src/cli/commands/create.ts";
import "./src/cli/commands/list.ts";
import "./src/cli/commands/status.ts";
import "./src/cli/commands/scale.ts";
import "./src/cli/commands/destroy.ts";
import "./src/cli/commands/mcp.ts";
import "./src/cli/commands/doctor.ts";

// =============================================================================
// Main
// =============================================================================

const main = async (): Promise<void> => {
  const spinner = new Spinner();

  // Handle signals
  try {
    Deno.addSignalListener("SIGINT", () => {
      spinner.stop();
      Deno.exit(130);
    });
    Deno.addSignalListener("SIGTERM", () => {
      spinner.stop();
      Deno.exit(143);
    });
  } catch {
    // Signal listeners may not be available on all platforms
  }

  await runCli(Deno.args);
};

// =============================================================================
// Entry
// =============================================================================

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof Error && error.message !== "exit") {
      statusErr(error.message);
    }
    Deno.exit(1);
  }
}
