// =============================================================================
// Doctor Command - Verify Environment and Infrastructure Health
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput, type Output } from "@/lib/output.ts";
import { runCommand } from "@/lib/command.ts";
import { registerCommand } from "@/cli/mod.ts";
import type { FlyProvider } from "@/providers/fly.ts";
import type { TailscaleProvider } from "@/providers/tailscale.ts";
import {
  isAcceptRoutesEnabled,
  isTailscaleInstalled,
} from "@/util/tailscale-local.ts";
import {
  findRouterApp,
  findWorkloadApp,
  getRouterMachineInfo,
  getRouterTailscaleInfo,
  listRouterApps,
  type RouterApp,
} from "@/util/discovery.ts";
import { initSession } from "@/util/session.ts";

// =============================================================================
// Types
// =============================================================================

interface CheckResult {
  name: string;
  ok: boolean;
  hint?: string;
}

type DoctorOutput = Output<{ checks: CheckResult[] }>;
type Reporter = (name: string, ok: boolean, hint?: string) => void;

// =============================================================================
// Reporter
// =============================================================================

const makeReporter = (
  results: CheckResult[],
  out: DoctorOutput,
): Reporter =>
(name, ok, hint) => {
  results.push({ name, ok, hint });
  if (ok) {
    out.ok(name);
  } else {
    out.err(name);
    if (hint) out.dim(`    ${hint}`);
  }
};

// =============================================================================
// Stage 1: Local Checks
// =============================================================================

const stageLocalChecks = async (report: Reporter): Promise<void> => {
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
};

// =============================================================================
// Router Health Helper (shared by network and app stages)
// =============================================================================

const checkRouter = async (
  fly: FlyProvider,
  tailscale: TailscaleProvider,
  report: Reporter,
  app: RouterApp,
): Promise<void> => {
  const { network } = app;

  report(`Router Exists (${network})`, true);

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

  if (ts) {
    const device = await tailscale.devices.getByHostname(app.appName);
    if (device) {
      const routes = await tailscale.routes.get(device.id);
      if (routes && routes.unapproved.length > 0) {
        await tailscale.routes.approve(device.id, routes.advertised);
        report(
          `Routes Approved (${network})`,
          true,
          `Approved: ${routes.unapproved.join(", ")}`,
        );
      } else if (routes && routes.advertised.length > 0) {
        report(`Routes Approved (${network})`, true);
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

// =============================================================================
// Stage 3a: Network Checks
// =============================================================================

const stageNetworkChecks = async (
  fly: FlyProvider,
  tailscale: TailscaleProvider,
  org: string,
  report: Reporter,
  network?: string,
): Promise<void> => {
  if (network) {
    const app = await findRouterApp(fly, org, network);
    if (!app) {
      report(
        `Router Exists (${network})`,
        false,
        `Create with: ambit create ${network}`,
      );
    } else {
      await checkRouter(fly, tailscale, report, app);
    }
  } else {
    const routerApps = await listRouterApps(fly, org);
    if (routerApps.length === 0) {
      report("Routers Discovered", false, "Run: ambit create <network>");
    } else {
      for (const app of routerApps) {
        await checkRouter(fly, tailscale, report, app);
      }
    }
  }
};

// =============================================================================
// Stage 3b: App Checks
// =============================================================================

const stageAppChecks = async (
  fly: FlyProvider,
  tailscale: TailscaleProvider,
  org: string,
  report: Reporter,
  app: string,
  network: string,
): Promise<void> => {
  const workload = await findWorkloadApp(fly, org, app, network);

  if (!workload) {
    report(
      `App Exists (${app}.${network})`,
      false,
      `Deploy with: ambit deploy ${app}.${network}`,
    );
    return;
  }

  report(`App Exists (${app}.${network})`, true);

  const machines = await fly.machines.list(workload.appName);
  const started = machines.find((m) => m.state === "started");
  report(
    `App Running (${app}.${network})`,
    started !== undefined,
    machines.length > 0
      ? `Machine State: ${machines[0].state}`
      : "No Machines Found",
  );

  const router = await findRouterApp(fly, org, network);
  if (!router) {
    report(
      `Router Exists (${network})`,
      false,
      `Create with: ambit create ${network}`,
    );
  } else {
    await checkRouter(fly, tailscale, report, router);
  }
};

// =============================================================================
// Stage 4: Summary
// =============================================================================

const stageSummary = (out: DoctorOutput, results: CheckResult[]): void => {
  const issues = results.filter((r) => !r.ok).length;

  if (issues === 0) {
    out.done({ checks: results });
  } else {
    out.fail(`${issues} Issue${issues > 1 ? "s" : ""} Found`, {
      checks: results,
    });
  }

  out.blank();
  out.text(issues === 0 ? "All Checks Passed." : `${issues} Issue${issues > 1 ? "s" : ""} Found.`);
  out.blank();
  out.print();
};

// =============================================================================
// Doctor Network
// =============================================================================

const doctorNetwork = async (argv: string[]): Promise<void> => {
  const opts = { string: ["network", "org"], boolean: ["help", "json"] } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit doctor network");

  if (args.help) {
    console.log(`
${bold("ambit doctor network")} - Check Router Health

${bold("USAGE")}
  ambit doctor network [<name>] [--org <org>] [--json]
  ambit doctor [--network <name>] [--org <org>] [--json]

${bold("OPTIONS")}
  <name>             Router network to check (checks all if omitted)
  --network <name>   Alias for positional <name>
  --org <org>        Fly.io organization slug
  --json             Output as JSON

${bold("CHECKS")}
  - Tailscale CLI installed and connected
  - Accept-routes enabled
  - Router created and running
  - Router visible in tailnet
  - Subnet routes approved
`);
    return;
  }

  const out = createOutput<{ checks: CheckResult[] }>(args.json);
  out.blank().header("ambit Doctor: Network").blank();

  const results: CheckResult[] = [];
  const report = makeReporter(results, out);

  const network =
    (typeof args._[0] === "string" ? args._[0] : undefined) || args.network;

  const { fly, tailscale, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  await stageLocalChecks(report);
  await stageNetworkChecks(fly, tailscale, org, report, network);
  stageSummary(out, results);
};

// =============================================================================
// Doctor App
// =============================================================================

const doctorApp = async (argv: string[]): Promise<void> => {
  const opts = { string: ["network", "org"], boolean: ["help", "json"] } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit doctor app");

  if (args.help) {
    console.log(`
${bold("ambit doctor app")} - Check App Health

${bold("USAGE")}
  ambit doctor app <app>.<network> [--org <org>] [--json]
  ambit doctor app <app> --network <name> [--org <org>] [--json]

${bold("OPTIONS")}
  --network <name>   Target network (if not using dot syntax)
  --org <org>        Fly.io organization slug
  --json             Output as JSON

${bold("CHECKS")}
  - Tailscale CLI installed and connected
  - Accept-routes enabled
  - App deployed and running
  - Router exists and is healthy
  - Subnet routes approved
`);
    return;
  }

  const out = createOutput<{ checks: CheckResult[] }>(args.json);

  const appArg = args._[0];
  if (!appArg || typeof appArg !== "string") {
    return out.die(
      "Missing App Name. Usage: ambit doctor app <app>.<network>",
    );
  }

  let app: string;
  let network: string;

  if (appArg.includes(".")) {
    const parts = appArg.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return out.die(
        `'${appArg}' Should Have Exactly One Dot, Like my-app.my-network`,
      );
    }
    app = parts[0];
    network = parts[1];
  } else {
    app = appArg;
    if (!args.network) {
      return out.die(
        `Missing Network. Use: ambit doctor app ${app}.<network>`,
      );
    }
    network = args.network;
  }

  out.blank().header(`ambit Doctor: App ${app}.${network}`).blank();

  const results: CheckResult[] = [];
  const report = makeReporter(results, out);

  const { fly, tailscale, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  await stageLocalChecks(report);
  await stageAppChecks(fly, tailscale, org, report, app, network);
  stageSummary(out, results);
};

// =============================================================================
// Top-Level Help
// =============================================================================

const showDoctorHelp = (): void => {
  console.log(`
${bold("ambit doctor")} - Verify Environment and Infrastructure Health

${bold("USAGE")}
  ambit doctor [options]
  ambit doctor network [<name>] [options]
  ambit doctor app <app>.<network> [options]

${bold("SUBCOMMANDS")}
  network    Check router(s) health — default when no subcommand given
  app        Check a specific app's health

${bold("OPTIONS")}
  --org <org>        Fly.io organization slug
  --json             Output as JSON

${bold("EXAMPLES")}
  ambit doctor
  ambit doctor network
  ambit doctor network browsers
  ambit doctor app my-app.browsers

Run 'ambit doctor network --help' or 'ambit doctor app --help' for details.
`);
};

// =============================================================================
// Dispatcher
// =============================================================================

const doctor = async (argv: string[]): Promise<void> => {
  const subcommand = typeof argv[0] === "string" ? argv[0] : undefined;

  if (subcommand === "network") return doctorNetwork(argv.slice(1));
  if (subcommand === "app") return doctorApp(argv.slice(1));

  const args = parseArgs(argv, { boolean: ["help"] });
  if (args.help) {
    showDoctorHelp();
    return;
  }

  return doctorNetwork(argv);
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "doctor",
  description: "Check that Tailscale and the router are working correctly",
  usage: "ambit doctor [network|app] [<name>] [--org <org>] [--json]",
  run: doctor,
});
