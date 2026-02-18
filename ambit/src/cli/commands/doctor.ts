// =============================================================================
// Doctor Command - Verify Environment and Infrastructure Health
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold } from "../../../lib/cli.ts";
import { createOutput } from "../../../lib/output.ts";
import { runCommand } from "../../../lib/command.ts";
import { registerCommand } from "../mod.ts";
import { createFlyProvider } from "../../providers/fly.ts";
import {
  isTailscaleInstalled,
  isAcceptRoutesEnabled,
} from "../../providers/tailscale.ts";
import { requireTailscaleProvider } from "../../credentials.ts";
import {
  listRouterApps,
  findRouterApp,
  getRouterMachineInfo,
  getRouterTailscaleInfo,
} from "../../discovery.ts";
import { resolveOrg } from "../../resolve.ts";

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
${bold("ambit doctor")} - Verify Environment and Infrastructure Health

${bold("USAGE")}
  ambit doctor [--network <name>] [--org <org>] [--json]

${bold("OPTIONS")}
  --network <name>   Check a specific router (otherwise checks all)
  --org <org>        Fly.io organization slug
  --json             Output as JSON

${bold("CHECKS")}
  - Tailscale CLI installed and connected
  - Accept-routes enabled
  - Router(s) created and running
  - Router(s) visible in tailnet
`);
    return;
  }

  const out = createOutput<{ checks: CheckResult[] }>(args.json);

  out.blank().header("ambit Doctor").blank();

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

  if (args.network) {
    const app = await findRouterApp(fly, org, args.network);
    report(
      `Router Exists (${args.network})`,
      app !== null,
      `Create with: ambit create ${args.network}`,
    );

    const machine = app ? await getRouterMachineInfo(fly, app.appName) : null;
    report(
      `Router Running (${args.network})`,
      machine?.state === "started",
      machine ? `Machine state: ${machine.state}` : "No machine found",
    );

    const ts = app ? await getRouterTailscaleInfo(tailscale, app.appName) : null;
    report(
      `Router in Tailnet (${args.network})`,
      ts !== null,
      "Router may still be starting, or check router logs",
    );
  } else {
    const routerApps = await listRouterApps(fly, org);
    if (routerApps.length === 0) {
      report("Routers Discovered", false, "Run: ambit create <network>");
    } else {
      let runningCount = 0;
      let inTailnetCount = 0;

      for (const app of routerApps) {
        const machine = await getRouterMachineInfo(fly, app.appName);
        if (machine?.state === "started") runningCount++;

        const ts = await getRouterTailscaleInfo(tailscale, app.appName);
        if (ts) inTailnetCount++;
      }

      report(
        "Routers Discovered",
        runningCount > 0,
        `${routerApps.length} Router(s): ${runningCount} Running, ${inTailnetCount} In Tailnet`,
      );
    }
  }

  // =========================================================================
  // Summary
  // =========================================================================

  const issues = results.filter((r) => !r.ok).length;

  if (issues === 0) {
    out.done({ checks: results });
  } else {
    out.fail(`${issues} Issue${issues > 1 ? "s" : ""} Found`, { checks: results });
  }

  out.blank();
  if (issues === 0) {
    out.text("All Checks Passed.");
  } else {
    out.text(`${issues} Issue${issues > 1 ? "s" : ""} Found.`);
  }
  out.blank();

  out.print();
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "doctor",
  description: "Check that Tailscale and the router are working correctly",
  usage: "ambit doctor [--network <name>] [--org <org>] [--json]",
  run: doctor,
});
