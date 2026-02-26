// =============================================================================
// Destroy App — Destroy a Workload App on a Network
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, confirm } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput, type Output } from "@/lib/output.ts";
import { Result } from "@/lib/result.ts";
import { type Machine, runMachine } from "@/lib/machine.ts";
import type { FlyProvider } from "@/providers/fly.ts";
import { findWorkloadApp } from "@/util/discovery.ts";
import { assertNotRouter } from "@/util/guard.ts";
import { initSession } from "@/util/session.ts";

// =============================================================================
// Phases
// =============================================================================

type DestroyAppPhase = "confirm" | "delete_app" | "complete";

type DestroyAppResult = {
  destroyed: boolean;
  appName: string;
  network: string;
};

interface DestroyAppCtx {
  fly: FlyProvider;
  out: Output<DestroyAppResult>;
  app: string;
  network: string;
  org: string;
  yes: boolean;
  json: boolean;
  flyAppName?: string;
}

// =============================================================================
// Hydration
// =============================================================================

const hydrateDestroyApp = async (
  ctx: DestroyAppCtx,
): Promise<DestroyAppPhase> => {
  const workloadApp = await findWorkloadApp(
    ctx.fly,
    ctx.org,
    ctx.app,
    ctx.network,
  );

  if (!workloadApp) {
    const anyApp = await findWorkloadApp(ctx.fly, ctx.org, ctx.app);
    if (anyApp) {
      ctx.out.die(
        `App '${ctx.app}' Exists on Network '${anyApp.network}', Not '${ctx.network}'`,
      );
    }
    return "complete";
  }

  ctx.flyAppName = workloadApp.appName;
  return "confirm";
};

// =============================================================================
// Transitions
// =============================================================================

const destroyAppTransition = async (
  phase: DestroyAppPhase,
  ctx: DestroyAppCtx,
): Promise<Result<DestroyAppPhase>> => {
  switch (phase) {
    case "confirm": {
      ctx.out.blank()
        .header("Ambit Destroy App")
        .blank()
        .text(`  App:      ${ctx.flyAppName}`)
        .text(`  Network:  ${ctx.network}`)
        .blank();

      if (!ctx.yes && !ctx.json) {
        const confirmed = await confirm(
          `Destroy App '${ctx.app}' on Network '${ctx.network}'?`,
        );
        if (!confirmed) {
          ctx.out.text("Cancelled.");
          return Result.err("Cancelled");
        }
        ctx.out.blank();
      }

      return Result.ok("delete_app");
    }

    case "delete_app": {
      if (ctx.flyAppName) {
        await ctx.out.spin("Deleting App", () =>
          ctx.fly.apps.delete(ctx.flyAppName!)
        );
        ctx.out.ok("Fly App Destroyed");
      } else {
        ctx.out.skip("Fly App Already Destroyed");
      }
      return Result.ok("complete");
    }

    default:
      return Result.err(`Unknown Phase: ${phase}`);
  }
};

// =============================================================================
// Stage 1: Destroy
// =============================================================================

const stageDestroy = async (
  out: Output<DestroyAppResult>,
  fly: FlyProvider,
  opts: {
    app: string;
    network: string;
    org: string;
    yes: boolean;
    json: boolean;
  },
): Promise<void> => {
  const ctx: DestroyAppCtx = { fly, out, ...opts };

  const phase = await hydrateDestroyApp(ctx);

  if (phase === "complete" && !ctx.flyAppName) {
    out.ok(`App '${opts.app}' on Network '${opts.network}' Already Destroyed`);
    out.print();
    return;
  }

  const machine: Machine<DestroyAppPhase, DestroyAppCtx> = {
    terminal: "complete",
    transition: destroyAppTransition,
  };

  const result = await runMachine(machine, phase, ctx);

  if (!result.ok) {
    if (result.error === "Cancelled") return;
    return out.die(result.error!);
  }

  stageSummary(out, ctx);
};

// =============================================================================
// Stage 3: Summary
// =============================================================================

const stageSummary = (
  out: Output<DestroyAppResult>,
  ctx: DestroyAppCtx,
): void => {
  out.done({
    destroyed: true,
    appName: ctx.flyAppName ?? ctx.app,
    network: ctx.network,
  });

  out.ok("App Destroyed");
  out.blank();
  out.print();
};

// =============================================================================
// Destroy App Command
// =============================================================================

export const destroyApp = async (argv: string[]): Promise<void> => {
  const opts = {
    string: ["network", "org"],
    boolean: ["help", "yes", "json"],
    alias: { y: "yes" },
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit destroy app");

  if (args.help) {
    console.log(`
${bold("ambit destroy app")} - Destroy a Workload App

${bold("USAGE")}
  ambit destroy app <app>.<network> [--org <org>] [--yes] [--json]
  ambit destroy app <app> --network <name> [--org <org>] [--yes] [--json]

${bold("OPTIONS")}
  --network <name>   Target network (if not using dot syntax)
  --org <org>        Fly.io organization slug
  -y, --yes          Skip confirmation prompts
  --json             Output as JSON

${bold("EXAMPLES")}
  ambit destroy app my-app.browsers
  ambit destroy app my-app --network browsers --yes
`);
    return;
  }

  const out = createOutput<DestroyAppResult>(args.json);

  const appArg = args._[0];
  if (!appArg || typeof appArg !== "string") {
    return out.die(
      "Missing App Name. Usage: ambit destroy app <app>.<network>",
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
    if (args.network) {
      return out.die(
        `Network Is Already Part of the Name ('${appArg}'), --network Is Not Needed`,
      );
    }
    app = parts[0];
    network = parts[1];
  } else {
    app = appArg;
    if (!args.network) {
      return out.die(
        `Missing Network. Use: ambit destroy app ${app}.<network>`,
      );
    }
    network = args.network;
  }

  try {
    assertNotRouter(app);
  } catch (e) {
    return out.die(e instanceof Error ? e.message : String(e));
  }

  const { fly, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  await stageDestroy(out, fly, {
    app,
    network,
    org,
    yes: args.yes,
    json: args.json,
  });
};
