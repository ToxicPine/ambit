// =============================================================================
// Destroy Network — Tear Down Router and Clean Up Tailnet
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, confirm } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput, type Output } from "@/lib/output.ts";
import { Result } from "@/lib/result.ts";
import { type Machine, runMachine } from "@/lib/machine.ts";
import type { FlyProvider } from "@/providers/fly.ts";
import type { TailscaleProvider } from "@/providers/tailscale.ts";
import type { TailscaleDevice } from "@/schemas/tailscale.ts";
import {
  findRouterApp,
  listWorkloadAppsOnNetwork,
} from "@/util/discovery.ts";
import { initSession } from "@/util/session.ts";

// =============================================================================
// Phases
// =============================================================================

type DestroyNetworkPhase =
  | "confirm"
  | "clear_dns"
  | "remove_device"
  | "delete_app"
  | "complete";

type DestroyNetworkResult = {
  destroyed: boolean;
  appName: string;
  workloadAppsWarned: number;
};

interface DestroyNetworkCtx {
  fly: FlyProvider;
  tailscale: TailscaleProvider;
  out: Output<DestroyNetworkResult>;
  network: string;
  org: string;
  yes: boolean;
  json: boolean;
  appName?: string;
  device?: TailscaleDevice;
  tag?: string;
}

// =============================================================================
// Phase Labels
// =============================================================================

const DESTROY_NETWORK_PHASES: { phase: DestroyNetworkPhase; label: string }[] =
  [
    { phase: "confirm", label: "Confirmed" },
    { phase: "clear_dns", label: "Split DNS Cleared" },
    { phase: "remove_device", label: "Tailscale Device Removed" },
    { phase: "delete_app", label: "Fly App Destroyed" },
  ];

const reportSkipped = (
  out: Output<DestroyNetworkResult>,
  startPhase: DestroyNetworkPhase,
) => {
  for (const { phase, label } of DESTROY_NETWORK_PHASES) {
    if (phase === startPhase) break;
    out.skip(label);
  }
};

// =============================================================================
// Hydration
// =============================================================================

const hydrateDestroyNetwork = async (
  ctx: DestroyNetworkCtx,
): Promise<DestroyNetworkPhase> => {
  const router = await findRouterApp(ctx.fly, ctx.org, ctx.network);
  const dns = await ctx.tailscale.dns.getSplit();
  const hasDns = (dns[ctx.network]?.length ?? 0) > 0;

  if (router) {
    ctx.appName = router.appName;
    const device = await ctx.tailscale.devices.getByHostname(router.appName);
    if (device) {
      ctx.device = device;
      ctx.tag = device.tags?.[0] ?? undefined;
    }
  }

  if (!router && !ctx.device && !hasDns) return "complete";

  if (!hasDns && !ctx.device && router) return "delete_app";
  if (!hasDns && ctx.device) return "remove_device";
  if (!hasDns) return router ? "delete_app" : "complete";

  return "confirm";
};

// =============================================================================
// Transitions
// =============================================================================

const destroyNetworkTransition = async (
  phase: DestroyNetworkPhase,
  ctx: DestroyNetworkCtx,
): Promise<Result<DestroyNetworkPhase>> => {
  switch (phase) {
    case "confirm": {
      const workloads = await listWorkloadAppsOnNetwork(
        ctx.fly,
        ctx.org,
        ctx.network,
      );

      ctx.out.blank()
        .header("Ambit Destroy Network")
        .blank()
        .text(`  Network:    ${ctx.network}`)
        .text(`  Router App: ${ctx.appName ?? "unknown"}`)
        .text(`  Tag:        ${ctx.tag ?? "unknown"}`)
        .blank();

      if (workloads.length > 0) {
        ctx.out.warn(
          `${workloads.length} Workload App(s) Still on Network '${ctx.network}':`,
        );
        for (const wa of workloads) {
          ctx.out.text(`  - ${wa.appName}`);
        }
        ctx.out.blank();
        ctx.out.dim(
          "These Apps Will Lose Connectivity when the Router Is Destroyed.",
        );
        ctx.out.dim(
          `Consider Destroying Them First with: ambit destroy app <name>.${ctx.network}`,
        );
        ctx.out.blank();
      }

      if (!ctx.yes && !ctx.json) {
        const confirmed = await confirm("Destroy This Router?");
        if (!confirmed) {
          ctx.out.text("Cancelled.");
          return Result.err("Cancelled");
        }
        ctx.out.blank();
      }

      return Result.ok("clear_dns");
    }

    case "clear_dns": {
      await ctx.tailscale.dns.clearSplit(ctx.network);
      ctx.out.ok("Split DNS Cleared");
      return Result.ok("remove_device");
    }

    case "remove_device": {
      if (ctx.device) {
        await ctx.tailscale.devices.delete(ctx.device.id);
        ctx.out.ok("Tailscale Device Removed");
      } else {
        ctx.out.skip("Tailscale Device Already Removed");
      }
      return Result.ok("delete_app");
    }

    case "delete_app": {
      if (ctx.appName) {
        await ctx.out.spin("Deleting App", () =>
          ctx.fly.apps.delete(ctx.appName!)
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
  out: Output<DestroyNetworkResult>,
  fly: FlyProvider,
  tailscale: TailscaleProvider,
  opts: { network: string; org: string; yes: boolean; json: boolean },
): Promise<void> => {
  const ctx: DestroyNetworkCtx = { fly, tailscale, out, ...opts };

  const phase = await hydrateDestroyNetwork(ctx);

  if (phase === "complete") {
    out.ok(`Network "${opts.network}" Already Destroyed`);
    out.print();
    return;
  }

  reportSkipped(out, phase);

  const machine: Machine<DestroyNetworkPhase, DestroyNetworkCtx> = {
    terminal: "complete",
    transition: destroyNetworkTransition,
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
  out: Output<DestroyNetworkResult>,
  ctx: DestroyNetworkCtx,
): void => {
  out.done({
    destroyed: true,
    appName: ctx.appName ?? "",
    workloadAppsWarned: 0,
  });

  out.ok("Router Destroyed");

  if (ctx.tag) {
    out.blank()
      .dim(
        "If You Added ACL Policy Entries for This Router, Remember to Remove:",
      )
      .dim(`  tagOwners:     ${ctx.tag}`)
      .dim(`  autoApprovers: routes for ${ctx.tag}`)
      .dim(`  acls:          rules referencing ${ctx.tag}`)
      .blank();
  } else {
    out.blank()
      .dim(
        "If You Added ACL Policy Entries for This Router, Remember to Remove",
      )
      .dim("the Associated Tag from tagOwners, autoApprovers, and acls.")
      .blank();
  }

  out.print();
};

// =============================================================================
// Destroy Network Command
// =============================================================================

export const destroyNetwork = async (argv: string[]): Promise<void> => {
  const opts = {
    string: ["network", "org"],
    boolean: ["help", "yes", "json"],
    alias: { y: "yes" },
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit destroy network");

  if (args.help) {
    console.log(`
${bold("ambit destroy network")} - Tear Down Router

${bold("USAGE")}
  ambit destroy network <name> [--org <org>] [--yes] [--json]

${bold("OPTIONS")}
  --org <org>        Fly.io organization slug
  -y, --yes          Skip confirmation prompts
  --json             Output as JSON

${bold("EXAMPLES")}
  ambit destroy network browsers
  ambit destroy network browsers --org my-org --yes
`);
    return;
  }

  const out = createOutput<DestroyNetworkResult>(args.json);

  const network =
    (typeof args._[0] === "string" ? args._[0] : undefined) || args.network;

  if (!network) {
    return out.die(
      "Network Name Required. Usage: ambit destroy network <name>",
    );
  }

  const { fly, tailscale, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  await stageDestroy(out, fly, tailscale, {
    network,
    org,
    yes: args.yes,
    json: args.json,
  });
};
