#!/usr/bin/env -S deno run -A
// =============================================================================
// ambit CLI - Tailscale Subnet Router for Fly.io Custom Networks
// =============================================================================
//
// Usage:
//   deno run -A main.ts <command> [options]
//   ambit <command> [options]
//
// Commands:
//   create     Create a Tailscale subnet router on a Fly.io custom network
//   deploy     Deploy an app safely on a custom private network
//   status     Show router status, network, and tailnet info
//   destroy    Destroy a network (router) or a workload app
//   doctor     Check that Tailscale and the router are working correctly
//
// Examples:
//   ambit create browsers
//   ambit status
//   ambit destroy network browsers
//   ambit destroy app my-app.browsers
//   ambit doctor
//
// =============================================================================

import { runCli } from "./src/cli/mod.ts";
import { Spinner, statusErr } from "./lib/cli.ts";

// Import commands to register them
import "./src/cli/commands/create.ts";
import "./src/cli/commands/deploy.ts";
import "./src/cli/commands/list.ts";
import "./src/cli/commands/status.ts";
import "./src/cli/commands/destroy.ts";
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
