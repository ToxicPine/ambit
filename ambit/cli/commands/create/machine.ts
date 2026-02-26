// =============================================================================
// Create — Phases, Context, Hydration, Transitions
// =============================================================================

import { randomId } from "@/lib/cli.ts";
import { type Output } from "@/lib/output.ts";
import { Result } from "@/lib/result.ts";
import { extractSubnet } from "@/util/fly-transforms.ts";
import {
  ROUTER_DOCKER_DIR,
  SECRET_NETWORK_NAME,
  SECRET_ROUTER_ID,
  SECRET_TAILSCALE_AUTHKEY,
} from "@/util/constants.ts";
import { FlyDeployError, type FlyProvider } from "@/providers/fly.ts";
import { getRouterAppName } from "@/util/naming.ts";
import {
  enableAcceptRoutes,
  isAcceptRoutesEnabled,
  isAutoApproverConfigured,
  isTailscaleInstalled,
  waitForDevice,
} from "@/util/tailscale-local.ts";
import type { TailscaleProvider } from "@/providers/tailscale.ts";
import type { TailscaleDevice } from "@/schemas/tailscale.ts";
import { findRouterApp, getRouterMachineInfo } from "@/util/discovery.ts";

// =============================================================================
// Phases
// =============================================================================

export type CreatePhase =
  | "create_app"
  | "deploy_router"
  | "await_device"
  | "approve_routes"
  | "configure_dns"
  | "accept_routes"
  | "complete";

// =============================================================================
// Context
// =============================================================================

export type CreateResult = {
  network: string;
  router: { appName: string; tailscaleIp: string | null };
  subnet: string | null;
  tag: string;
};

export interface CreateCtx {
  fly: FlyProvider;
  tailscale: TailscaleProvider;
  out: Output<CreateResult>;
  network: string;
  org: string;
  region: string;
  tag: string;
  shouldApprove: boolean;
  appName: string;
  routerId: string;
  device?: TailscaleDevice;
  subnet?: string;
}

// =============================================================================
// Phase Labels
// =============================================================================

const CREATE_PHASES: { phase: CreatePhase; label: string }[] = [
  { phase: "create_app", label: "Fly App Created" },
  { phase: "deploy_router", label: "Router Deployed" },
  { phase: "await_device", label: "Router in Tailnet" },
  { phase: "approve_routes", label: "Routes Approved" },
  { phase: "configure_dns", label: "Split DNS Configured" },
  { phase: "accept_routes", label: "Accept Routes Enabled" },
];

export const reportSkipped = (
  out: Output<CreateResult>,
  startPhase: CreatePhase,
) => {
  for (const { phase, label } of CREATE_PHASES) {
    if (phase === startPhase) break;
    out.skip(label);
  }
};

// =============================================================================
// Hydration — determine starting phase from infrastructure state
// =============================================================================

export const hydrateCreate = async (
  ctx: CreateCtx,
): Promise<CreatePhase> => {
  const router = await findRouterApp(ctx.fly, ctx.org, ctx.network);
  if (!router) return "create_app";

  ctx.appName = router.appName;
  ctx.routerId = router.routerId;

  const machine = await getRouterMachineInfo(ctx.fly, router.appName);
  if (!machine || machine.state !== "started") return "deploy_router";

  ctx.subnet = machine.subnet;

  if (!ctx.shouldApprove) return "complete";

  const device = await ctx.tailscale.devices.getByHostname(router.appName);
  if (!device) return "await_device";

  ctx.device = device;

  const routes = await ctx.tailscale.routes.get(device.id);
  if (!routes || routes.unapproved.length > 0) return "approve_routes";

  const dns = await ctx.tailscale.dns.getSplit();
  if (!dns[ctx.network]?.length) return "configure_dns";

  if (!(await isAcceptRoutesEnabled())) return "accept_routes";

  return "complete";
};

// =============================================================================
// Transitions
// =============================================================================

export const createTransition = async (
  phase: CreatePhase,
  ctx: CreateCtx,
): Promise<Result<CreatePhase>> => {
  switch (phase) {
    case "create_app": {
      const suffix = randomId(8);
      ctx.appName = getRouterAppName(ctx.network, suffix);
      ctx.routerId = suffix;
      await ctx.out.spin(
        "Creating App",
        () =>
          ctx.fly.apps.create(ctx.appName, ctx.org, { network: ctx.network }),
      );
      ctx.out.ok(`Created App: ${ctx.appName}`);
      return Result.ok("deploy_router");
    }

    case "deploy_router": {
      const authKey = await ctx.tailscale.auth.createKey({
        reusable: false,
        ephemeral: false,
        preauthorized: true,
        tags: [ctx.tag],
      });
      ctx.out.ok("Auth Key Created");

      await ctx.out.spin(
        "Setting Secrets",
        () =>
          ctx.fly.secrets.set(ctx.appName, {
            [SECRET_TAILSCALE_AUTHKEY]: authKey,
            [SECRET_NETWORK_NAME]: ctx.network,
            [SECRET_ROUTER_ID]: ctx.routerId,
          }, { stage: true }),
      );

      const dockerDir = ROUTER_DOCKER_DIR;
      const deploySpinner = ctx.out.spinner("Deploying Router to Fly.io");

      try {
        await ctx.fly.deploy.router(ctx.appName, dockerDir, {
          region: ctx.region,
        });
      } catch (e) {
        deploySpinner.fail("Router Deploy Failed");
        if (e instanceof FlyDeployError) {
          ctx.out.dim(`  ${e.detail}`);
          return Result.err(e.message);
        }
        throw e;
      }
      deploySpinner.success("Router Deployed");

      const machines = await ctx.fly.machines.list(ctx.appName);
      const m = machines.find((m) => m.private_ip);
      if (m?.private_ip) ctx.subnet = extractSubnet(m.private_ip);

      if (!ctx.shouldApprove) return Result.ok("complete");

      return Result.ok("await_device");
    }

    case "await_device": {
      ctx.device = await waitForDevice(ctx.tailscale, ctx.appName, 180000);
      ctx.out.ok(`Router Joined Tailnet: ${ctx.device.addresses[0]}`);

      if (!ctx.subnet) {
        const machines = await ctx.fly.machines.list(ctx.appName);
        const m = machines.find((m) => m.private_ip);
        if (m?.private_ip) ctx.subnet = extractSubnet(m.private_ip);
      }

      return Result.ok("approve_routes");
    }

    case "approve_routes": {
      if (!ctx.device || !ctx.subnet) {
        return Result.err("Missing Device or Subnet");
      }

      const policy = await ctx.tailscale.acl.getPolicy();
      const hasAutoApprover = isAutoApproverConfigured(policy, ctx.tag);
      if (hasAutoApprover) {
        ctx.out.ok("Routes Auto-Approved via ACL Policy");
      } else {
        await ctx.tailscale.routes.approve(ctx.device.id, [ctx.subnet]);
        ctx.out.ok("Subnet Routes Approved");
      }
      return Result.ok("configure_dns");
    }

    case "configure_dns": {
      if (!ctx.device) return Result.err("Missing Device");
      await ctx.tailscale.dns.setSplit(ctx.network, [ctx.device.addresses[0]]);
      ctx.out.ok(`Split DNS Configured: *.${ctx.network}`);
      return Result.ok("accept_routes");
    }

    case "accept_routes": {
      if (await isTailscaleInstalled()) {
        if (await isAcceptRoutesEnabled()) {
          ctx.out.ok("Accept Routes Already Enabled");
        } else if (await enableAcceptRoutes()) {
          ctx.out.ok("Accept Routes Enabled");
        } else {
          ctx.out.warn("Could Not Enable Accept Routes");
          ctx.out.dim("  Run: sudo tailscale set --accept-routes");
        }
      } else {
        ctx.out.warn("Tailscale CLI Not Found");
        ctx.out.dim("  Ensure Accept-Routes is Enabled on This Device");
      }
      return Result.ok("complete");
    }

    default:
      return Result.err(`Unknown Phase: ${phase}`);
  }
};
