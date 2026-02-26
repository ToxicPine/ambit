// =============================================================================
// Tailscale Local — CLI Operations + Pure Policy Checks
// =============================================================================

import { commandExists, die } from "@/lib/cli.ts";
import { runCommand } from "@/lib/command.ts";
import type { TailscaleDevice } from "@/schemas/tailscale.ts";
import type { TailscaleProvider } from "@/providers/tailscale.ts";

// =============================================================================
// Local CLI Operations
// =============================================================================

export const isTailscaleInstalled = async (): Promise<boolean> => {
  return await commandExists("tailscale");
};

export const isAcceptRoutesEnabled = async (): Promise<boolean> => {
  const result = await runCommand(["tailscale", "debug", "prefs"]);
  return result.json<{ RouteAll?: boolean }>().match({
    ok: (prefs) => prefs.RouteAll === true,
    err: () => false,
  });
};

/**
 * Enable accept-routes on the local client.
 * Returns true if successful, false if it failed (likely permissions).
 */
export const enableAcceptRoutes = async (): Promise<boolean> => {
  const result = await runCommand(["tailscale", "set", "--accept-routes"]);
  return result.ok;
};

// =============================================================================
// Wait for Device
// =============================================================================

export const waitForDevice = async (
  provider: TailscaleProvider,
  hostname: string,
  timeoutMs: number = 120000,
): Promise<TailscaleDevice> => {
  const startTime = Date.now();
  const pollInterval = 5000;

  while (Date.now() - startTime < timeoutMs) {
    const device = await provider.devices.getByHostname(hostname);
    if (device) {
      return device;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return die(`Timeout Waiting for Device '${hostname}'`);
};

// =============================================================================
// Pure Policy Checks
// =============================================================================

export const isTagOwnerConfigured = (
  policy: Record<string, unknown> | null,
  tag: string,
): boolean => {
  if (!policy) return false;

  const tagOwners = policy.tagOwners as
    | Record<string, string[]>
    | undefined;
  if (!tagOwners) return false;

  return tag in tagOwners;
};

export const isAutoApproverConfigured = (
  policy: Record<string, unknown> | null,
  tag: string,
): boolean => {
  if (!policy) return false;

  const autoApprovers = policy.autoApprovers as
    | Record<string, unknown>
    | undefined;
  if (!autoApprovers) return false;

  const routes = autoApprovers.routes as
    | Record<string, string[]>
    | undefined;
  if (!routes) return false;

  return Object.values(routes).some(
    (approvers) => Array.isArray(approvers) && approvers.includes(tag),
  );
};
