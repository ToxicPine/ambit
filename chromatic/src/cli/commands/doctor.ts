// =============================================================================
// Doctor Command - Verify Environment and Infrastructure Health
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold } from "@ambit/cli/lib/cli";
import { createOutput } from "@ambit/cli/lib/output";
import { runCommand } from "@ambit/cli/lib/command";
import { resolveOrg } from "@ambit/cli/src/resolve";
import { registerCommand } from "../mod.ts";
import { loadConfig } from "../../schemas/config.ts";
import { listCdpApps } from "../../schemas/instance.ts";
import { createFlyProvider } from "@ambit/cli/providers/fly";
import {
  isTailscaleInstalled,
  isAcceptRoutesEnabled,
} from "@ambit/cli/providers/tailscale";
import { requireTailscaleProvider } from "@ambit/cli/src/credentials";
import {
  findRouterApp,
  getRouterMachineInfo,
  getRouterTailscaleInfo,
} from "@ambit/cli/src/discovery";

// =============================================================================
// Types
// =============================================================================

interface CheckResult {
  name: string;
  ok: boolean;
  hint?: string;
}

// =============================================================================
// Doctor Command
// =============================================================================

const doctor = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["network", "org"],
    boolean: ["help", "json"],
  });

  if (args.help) {
    console.log(`
${bold("chromatic doctor")} - Check Environment and Infrastructure Health

${bold("USAGE")}
  chromatic doctor [options]

${bold("OPTIONS")}
  --network <name>  Network name (default: from config)
  --org <org>       Fly.io organization slug
  --json            Output as JSON

${bold("CHECKS")}
  - Tailscale CLI installed and connected
  - Accept-routes enabled
  - Router exists and running on network
  - Router visible in tailnet
  - CDP browsers on network
`);
    return;
  }

  const out = createOutput<{ ok: boolean; checks: CheckResult[] }>(args.json);

  out.blank().header("Chromatic Doctor").blank();

  const config = await loadConfig();
  const network = args.network ?? config.network;
  const results: CheckResult[] = [];

  const report = (name: string, ok: boolean, hint?: string) => {
    results.push({ name, ok, hint });
    if (ok) {
      out.ok(name);
    } else {
      out.err(name);
      if (hint) out.dim(`    ${hint}`);
    }
  };

  // =========================================================================
  // Prerequisites (fail fast)
  // =========================================================================

  const fly = createFlyProvider();
  await fly.ensureInstalled();
  await fly.ensureAuth({ interactive: !args.json });
  const tailscale = await requireTailscaleProvider(out);
  const org = await resolveOrg(fly, args, out);

  // =========================================================================
  // Local checks
  // =========================================================================

  report(
    "Tailscale Installed",
    await isTailscaleInstalled(),
    "Install from https://tailscale.com/download",
  );

  const tsStatus = await runCommand(["tailscale", "status", "--json"]);
  let tsConnected = false;
  if (tsStatus.success) {
    try {
      const parsed = JSON.parse(tsStatus.stdout);
      tsConnected = parsed.BackendState === "Running";
    } catch { /* ignore */ }
  }
  report("Tailscale Connected", tsConnected, "Run: tailscale up");

  report(
    "Accept Routes Enabled",
    await isAcceptRoutesEnabled(),
    "Run: sudo tailscale set --accept-routes",
  );

  // =========================================================================
  // Router checks
  // =========================================================================

  const routerApp = await findRouterApp(fly, org, network);
  report(
    `Router on '${network}'`,
    routerApp !== null,
    `Deploy with: ambit deploy --network ${network}`,
  );

  const machine = routerApp ? await getRouterMachineInfo(fly, routerApp.appName) : null;
  report(
    `Router Running (${network})`,
    machine?.state === "started",
    machine ? `Machine state: ${machine.state}` : "No router found",
  );

  const ts = routerApp ? await getRouterTailscaleInfo(tailscale, routerApp.appName) : null;
  report(
    `Router in Tailnet (${network})`,
    ts !== null,
    "Router may still be starting, or check router logs",
  );

  // =========================================================================
  // Browser checks
  // =========================================================================

  const cdpApps = await listCdpApps(fly, org, network);
  report(
    `Browsers on '${network}'`,
    cdpApps.length > 0,
    "Create one with: chromatic create <name>",
  );

  // =========================================================================
  // Summary
  // =========================================================================

  const issues = results.filter((r) => !r.ok).length;

  out.blank();
  if (issues === 0) {
    out.text("All Checks Passed.");
  } else {
    out.text(`${issues} Issue${issues > 1 ? "s" : ""} Found.`);
  }
  out.blank();

  out.done({ ok: issues === 0, checks: results });
  out.print();
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "doctor",
  description: "Check environment, credentials, and router health",
  usage: "chromatic doctor [--network NAME] [--org ORG] [--json]",
  run: doctor,
});
