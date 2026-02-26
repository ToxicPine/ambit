// =============================================================================
// Deploy — Phases, Context, Hydration, Transitions
// =============================================================================

import { confirm } from "@/lib/cli.ts";
import {
  SECRET_AMBIT_OUTBOUND_PROXY,
  SOCKS_PROXY_PORT,
} from "@/util/constants.ts";
import { type Output } from "@/lib/output.ts";
import { Result } from "@/lib/result.ts";
import {
  FlyDeployError,
  type FlyProvider,
  type SafeDeployOptions,
} from "@/providers/fly.ts";
import { auditDeploy } from "@/util/guard.ts";
import type { DeployConfig } from "./modes.ts";

// =============================================================================
// Phases
// =============================================================================

export type DeployPhase =
  | "create_app"
  | "set_proxy"
  | "deploy"
  | "audit"
  | "complete";

// =============================================================================
// Context
// =============================================================================

export type DeployResult = {
  app: string;
  network: string;
  created: boolean;
  audit: {
    public_ips_released: number;
    certs_removed: number;
    flycast_allocations: Array<{ address: string; network: string }>;
    warnings: string[];
  };
  preflight: {
    scanned: boolean;
    warnings: string[];
  };
};

export interface DeployCtx {
  fly: FlyProvider;
  out: Output<DeployResult>;
  app: string;
  network: string;
  org: string;
  region?: string;
  yes: boolean;
  json: boolean;
  routerId: string;
  flyAppName: string;
  routerPrivateIp?: string;
  created: boolean;
  deployConfig: DeployConfig;
  deployOptions: SafeDeployOptions;
  audit?: {
    public_ips_released: number;
    certs_removed: number;
    flycast_allocations: Array<{ address: string; network: string }>;
    warnings: string[];
  };
}

// =============================================================================
// Phase Labels
// =============================================================================

const DEPLOY_PHASES: { phase: DeployPhase; label: string }[] = [
  { phase: "create_app", label: "App Created" },
  { phase: "set_proxy", label: "Outbound Proxy Set" },
  { phase: "deploy", label: "Deployed" },
  { phase: "audit", label: "Audit Passed" },
];

export const reportDeploySkipped = (
  out: Output<DeployResult>,
  startPhase: DeployPhase,
) => {
  for (const { phase, label } of DEPLOY_PHASES) {
    if (phase === startPhase) break;
    out.skip(label);
  }
};

// =============================================================================
// Hydration
// =============================================================================

export const hydrateDeploy = async (
  ctx: DeployCtx,
): Promise<DeployPhase> => {
  const exists = await ctx.fly.apps.exists(ctx.flyAppName);
  if (!exists) return "create_app";

  // App exists — always re-run set_proxy, deploy, and audit (they're idempotent)
  return "set_proxy";
};

// =============================================================================
// Transitions
// =============================================================================

export const deployTransition = async (
  phase: DeployPhase,
  ctx: DeployCtx,
): Promise<Result<DeployPhase>> => {
  switch (phase) {
    case "create_app": {
      ctx.out.info(
        `App '${ctx.flyAppName}' Does Not Exist — Will Create on Network '${ctx.network}'`,
      );

      if (!ctx.yes && !ctx.json) {
        const confirmed = await confirm(
          `Create App '${ctx.flyAppName}' on Network '${ctx.network}'?`,
        );
        if (!confirmed) {
          ctx.out.text("Cancelled.");
          return Result.err("Cancelled");
        }
      }

      await ctx.out.spin(
        "Creating App",
        () =>
          ctx.fly.apps.create(ctx.app, ctx.org, {
            network: ctx.network,
            routerId: ctx.routerId,
          }),
      );
      ctx.out.ok(
        `Created App '${ctx.flyAppName}' on Network '${ctx.network}'`,
      );
      ctx.created = true;
      return Result.ok("set_proxy");
    }

    case "set_proxy": {
      if (!ctx.created) {
        ctx.out.skip(`App '${ctx.flyAppName}' Exists`);
      }

      if (ctx.routerPrivateIp) {
        const proxyUrl =
          `socks5://[${ctx.routerPrivateIp}]:${SOCKS_PROXY_PORT}`;
        await ctx.out.spin("Setting Outbound Proxy", () =>
          ctx.fly.secrets.set(
            ctx.flyAppName,
            { [SECRET_AMBIT_OUTBOUND_PROXY]: proxyUrl },
            { stage: true },
          ));
        ctx.out.ok(`Outbound Proxy: ${proxyUrl}`);
      }

      return Result.ok("deploy");
    }

    case "deploy": {
      ctx.out.blank();
      const deploySpinner = ctx.out.spinner("Deploying to Fly.io");

      try {
        await ctx.fly.deploy.app(ctx.app, ctx.deployOptions);
      } catch (e) {
        deploySpinner.fail("Deploy Failed");
        if (e instanceof FlyDeployError) {
          ctx.out.dim(`  ${e.detail}`);
          return Result.err(e.message);
        }
        throw e;
      } finally {
        if (ctx.deployConfig.tempDir) {
          try {
            Deno.removeSync(ctx.deployConfig.tempDir, { recursive: true });
          } catch {
            /* ignore */
          }
        }
      }

      deploySpinner.success("Deploy Succeeded");
      return Result.ok("audit");
    }

    case "audit": {
      ctx.out.blank();
      const auditSpinner = ctx.out.spinner("Auditing Deployment");
      ctx.audit = await auditDeploy(ctx.fly, ctx.flyAppName, ctx.network);
      auditSpinner.success("Audit Complete");

      if (ctx.audit.public_ips_released > 0) {
        ctx.out.warn(
          `Released ${ctx.audit.public_ips_released} Public IP(s)`,
        );
      }

      if (ctx.audit.certs_removed > 0) {
        ctx.out.ok(`Removed ${ctx.audit.certs_removed} Public Certificate(s)`);
      }

      for (const alloc of ctx.audit.flycast_allocations) {
        ctx.out.ok(`Flycast: ${alloc.address} (network: ${alloc.network})`);
      }

      for (const warn of ctx.audit.warnings) {
        ctx.out.warn(warn);
      }

      return Result.ok("complete");
    }

    default:
      return Result.err(`Unknown Phase: ${phase}`);
  }
};
