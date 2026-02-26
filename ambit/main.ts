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
//   share      Grant a group access to a network via Tailscale ACL rules
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

import { runCli } from "@/cli/mod.ts";
import { Spinner, statusErr } from "@/lib/cli.ts";

import "./cli/commands/create/index.ts";
import "./cli/commands/deploy/index.ts";
import "./cli/commands/share.ts";
import "./cli/commands/list.ts";
import "./cli/commands/status.ts";
import "./cli/commands/destroy/index.ts";
import "./cli/commands/doctor.ts";

// =============================================================================
// Main
// =============================================================================

const main = async (): Promise<void> => {
  const spinner = new Spinner();

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
