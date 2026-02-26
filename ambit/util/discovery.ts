// =============================================================================
// Discovery - Building Blocks for Router State
// =============================================================================
//
// Three independent data sources, composed by callers:
//
//   1. listRouterApps / findRouterApp  (Fly REST API — which routers exist)
//   2. getRouterMachineInfo            (Fly Machines API — is it running?)
//   3. getRouterTailscaleInfo          (Tailscale API — is it reachable?)
//
// Each is a separate API call with a clear purpose.
// Commands compose them into whatever view they need.
//
// =============================================================================

import type { FlyProvider } from "@/providers/fly.ts";
import { getRouterSuffix, getWorkloadAppName } from "@/util/naming.ts";
import type { TailscaleProvider } from "@/providers/tailscale.ts";
import { extractSubnet } from "@/util/fly-transforms.ts";
import {
  DEFAULT_FLY_NETWORK,
  ROUTER_APP_PREFIX,
} from "@/util/constants.ts";

// =============================================================================
// Types
// =============================================================================

/** A router app discovered from the Fly REST API. */
export interface RouterApp {
  appName: string;
  network: string;
  org: string;
  routerId: string;
}

/** Machine state for a router, from the Fly Machines API. */
export interface RouterMachineInfo {
  region: string;
  state: string;
  privateIp?: string;
  subnet?: string;
}

/** Tailscale device state for a router. */
export interface RouterTailscaleInfo {
  ip: string;
  online: boolean;
  hostname: string;
  tags?: string[];
}

// =============================================================================
// 1. Which routers exist? (Fly REST API)
// =============================================================================

/** List all ambit apps on custom networks in an org. */
export const listRouterApps = async (
  fly: FlyProvider,
  org: string,
): Promise<RouterApp[]> => {
  const apps = await fly.apps.listWithNetwork(org);

  return apps
    .filter(
      (app) =>
        app.name.startsWith(ROUTER_APP_PREFIX) &&
        app.network !== DEFAULT_FLY_NETWORK,
    )
    .map((app) => ({
      appName: app.name,
      network: app.network,
      org: app.organization?.slug ?? org,
      routerId: getRouterSuffix(app.name, app.network),
    }));
};

/** Find the router app for a specific network. */
export const findRouterApp = async (
  fly: FlyProvider,
  org: string,
  network: string,
): Promise<RouterApp | null> => {
  const apps = await listRouterApps(fly, org);
  return apps.find((a) => a.network === network) ?? null;
};

// =============================================================================
// 1b. Which workload apps exist? (Fly REST API)
// =============================================================================

/** A workload (non-router) app discovered from the Fly REST API. */
export interface WorkloadApp {
  appName: string;
  network: string;
  org: string;
}

/** List all non-router apps on a specific custom network in an org. */
export const listWorkloadAppsOnNetwork = async (
  fly: FlyProvider,
  org: string,
  network: string,
): Promise<WorkloadApp[]> => {
  const apps = await fly.apps.listWithNetwork(org);

  return apps
    .filter(
      (app) =>
        !app.name.startsWith(ROUTER_APP_PREFIX) &&
        app.network === network,
    )
    .map((app) => ({
      appName: app.name,
      network: app.network,
      org: app.organization?.slug ?? org,
    }));
};

/** Find a specific workload app by logical name, optionally scoped to a network.
 *  When a network is provided, resolves the router-suffixed Fly app name
 *  (e.g. "thing" on network "lab" with routerId "abc123" → "thing-abc123"). */
export const findWorkloadApp = async (
  fly: FlyProvider,
  org: string,
  appName: string,
  network?: string,
): Promise<WorkloadApp | null> => {
  const apps = await fly.apps.listWithNetwork(org);

  const workloads = apps
    .filter(
      (app) =>
        !app.name.startsWith(ROUTER_APP_PREFIX) &&
        app.network !== DEFAULT_FLY_NETWORK,
    )
    .map((app) => ({
      appName: app.name,
      network: app.network,
      org: app.organization?.slug ?? org,
    }));

  if (network) {
    // Resolve the router's suffix so we can match the suffixed Fly app name
    const router = await findRouterApp(fly, org, network);
    if (router) {
      const suffixedName = getWorkloadAppName(appName, router.routerId);
      const found = workloads.find((a) => a.appName === suffixedName && a.network === network);
      if (found) return found;
    }
    // Fallback: try exact match (for pre-suffix apps or direct Fly name)
    return workloads.find((a) => a.appName === appName && a.network === network) ?? null;
  }
  // Without network, try exact match only
  return workloads.find((a) => a.appName === appName) ?? null;
};

// =============================================================================
// 2. What's the machine state? (Fly Machines API)
// =============================================================================

/** Get machine info for a router app. Returns null if no machines exist. */
export const getRouterMachineInfo = async (
  fly: FlyProvider,
  appName: string,
): Promise<RouterMachineInfo | null> => {
  const machines = await fly.machines.list(appName);
  const machine = machines[0];
  if (!machine) return null;

  const privateIp = machine.private_ip;
  const subnet = privateIp ? extractSubnet(privateIp) : undefined;

  return {
    region: machine.region,
    state: machine.state,
    privateIp,
    subnet,
  };
};

// =============================================================================
// 3. What's the tailscale state? (Tailscale API)
// =============================================================================

/** Get tailscale device info for a router. Returns null if not found. */
export const getRouterTailscaleInfo = async (
  tailscale: TailscaleProvider,
  appName: string,
): Promise<RouterTailscaleInfo | null> => {
  try {
    const device = await tailscale.devices.getByHostname(appName);
    if (!device) return null;

    return {
      ip: device.addresses[0],
      online: device.online ?? false,
      hostname: device.hostname,
      tags: device.tags,
    };
  } catch {
    return null;
  }
};

// =============================================================================
// 4. Hydrated Router (all three sources combined)
// =============================================================================

/** A router app with its machine and Tailscale state hydrated. */
export type RouterWithInfo = RouterApp & {
  machine: RouterMachineInfo | null;
  tailscale: RouterTailscaleInfo | null;
};

/**
 * Discover all routers in an org and hydrate each with machine + Tailscale state.
 * Shows a spinner while fetching. Fetches all routers in parallel.
 */
export const discoverRouters = async (
  out: { spinner(msg: string): { success(msg: string): void } },
  fly: FlyProvider,
  tailscale: TailscaleProvider,
  org: string,
): Promise<RouterWithInfo[]> => {
  const spinner = out.spinner("Discovering Routers");
  const routerApps = await listRouterApps(fly, org);
  spinner.success(
    `Found ${routerApps.length} Router${routerApps.length !== 1 ? "s" : ""}`,
  );
  return Promise.all(
    routerApps.map(async (app) => ({
      ...app,
      machine: await getRouterMachineInfo(fly, app.appName),
      tailscale: await getRouterTailscaleInfo(tailscale, app.appName),
    })),
  );
};
