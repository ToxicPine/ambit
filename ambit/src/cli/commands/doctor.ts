// =============================================================================
// Doctor Command - Verify Environment and Infrastructure Health
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold } from "@/lib/cli.ts";
import { createOutput } from "@/lib/output.ts";
import { runCommand } from "@/lib/command.ts";
import { registerCommand } from "../mod.ts";
import { createFlyProvider } from "@/src/providers/fly.ts";
import {
  createTailscaleProvider,
  isAcceptRoutesEnabled,
  isTailscaleInstalled,
} from "@/src/providers/tailscale.ts";
import { checkDependencies } from "@/src/credentials.ts";
import {
  findRouterApp,
  getRouterMachineInfo,
  getRouterTailscaleInfo,
  listRouterApps,
  type RouterApp,
} from "@/src/discovery.ts";
import { resolveOrg } from "@/src/resolve.ts";

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
  // Prerequisites
  // =========================================================================

  const { tailscaleKey } = await checkDependencies(out);

  const fly = createFlyProvider();
  await fly.ensureAuth({ interactive: !args.json });
  const tailscale = createTailscaleProvider("-", tailscaleKey);
  const org = await resolveOrg(fly, args, out);

  // =========================================================================
  // Local Checks
  // =========================================================================

  report(
    "Tailscale Installed",
    await isTailscaleInstalled(),
    "Install from https://tailscale.com/download",
  );

  const tsStatus = await runCommand(["tailscale", "status", "--json"]);
  let tsConnected = false;
  if (tsStatus.ok) {
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
  // Router Checks
  // =========================================================================

  // Helper: check a single router's health and routes
  const checkRouter = async (app: RouterApp) => {
    const network = app.network;

    report(
      `Router Exists (${network})`,
      true,
    );

    const machine = await getRouterMachineInfo(fly, app.appName);
    report(
      `Router Running (${network})`,
      machine?.state === "started",
      machine ? `Machine State: ${machine.state}` : "No Machine Found",
    );

    const ts = await getRouterTailscaleInfo(tailscale, app.appName);
    report(
      `Router in Tailnet (${network})`,
      ts !== null,
      "Router May Still Be Starting, or Check Router Logs",
    );

    // Check route approval — approve unapproved routes if found
    if (ts) {
      const device = await tailscale.getDeviceByHostname(app.appName);
      if (device) {
        const routes = await tailscale.getDeviceRoutes(device.id);
        if (routes && routes.unapproved.length > 0) {
          await tailscale.approveSubnetRoutes(device.id, routes.advertised);
          report(
            `Routes Approved (${network})`,
            true,
            `Approved: ${routes.unapproved.join(", ")}`,
          );
        } else if (routes && routes.advertised.length > 0) {
          report(
            `Routes Approved (${network})`,
            true,
          );
        } else {
          report(
            `Routes Approved (${network})`,
            false,
            "No Routes Advertised — Router May Need Restart",
          );
        }
      }
    }
  };

  if (args.network) {
    const app = await findRouterApp(fly, org, args.network);
    if (!app) {
      report(
        `Router Exists (${args.network})`,
        false,
        `Create with: ambit create ${args.network}`,
      );
    } else {
      await checkRouter(app);
    }
  } else {
    const routerApps = await listRouterApps(fly, org);
    if (routerApps.length === 0) {
      report("Routers Discovered", false, "Run: ambit create <network>");
    } else {
      for (const app of routerApps) {
        await checkRouter(app);
      }
    }
  }

  // =========================================================================
  // Summary
  // =========================================================================

  const issues = results.filter((r) => !r.ok).length;

  if (issues === 0) {
    out.done({ checks: results });
  } else {
    out.fail(`${issues} Issue${issues > 1 ? "s" : ""} Found`, {
      checks: results,
    });
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
