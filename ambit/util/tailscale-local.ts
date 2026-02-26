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
// Sanity Guards
// =============================================================================

/**
 * Asserts that a patch operation only added data and never removed any
 * top-level key or shortened any existing array. Throws if the invariant is
 * violated so callers can surface a hard error before writing to the API.
 */
export const assertAdditivePatch = (
  original: Record<string, unknown>,
  patched: Record<string, unknown>,
): void => {
  for (const key of Object.keys(original)) {
    if (!(key in patched)) {
      throw new Error(
        `ACL sanity check failed: key '${key}' was unexpectedly removed`,
      );
    }
    const origVal = original[key];
    const patchedVal = patched[key];
    if (Array.isArray(origVal) && Array.isArray(patchedVal)) {
      if (patchedVal.length < origVal.length) {
        throw new Error(
          `ACL sanity check failed: '${key}' array shrank (${origVal.length} → ${patchedVal.length} entries)`,
        );
      }
    }
  }
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

// =============================================================================
// ACL Policy Patching (Pure)
// =============================================================================

/**
 * Returns a new policy with the given tag added to tagOwners.
 * No-op if the tag is already present.
 */
export const patchTagOwner = (
  policy: Record<string, unknown>,
  tag: string,
  owners: string[] = ["autogroup:admin"],
): Record<string, unknown> => {
  const tagOwners = (policy.tagOwners ?? {}) as Record<string, string[]>;
  if (tag in tagOwners) return policy;
  return { ...policy, tagOwners: { ...tagOwners, [tag]: owners } };
};

/**
 * Returns a new policy with the given route + tag added to autoApprovers.
 * No-op if the tag is already an approver for any route.
 */
export const patchAutoApprover = (
  policy: Record<string, unknown>,
  tag: string,
  route: string,
): Record<string, unknown> => {
  const autoApprovers = (policy.autoApprovers ?? {}) as Record<string, unknown>;
  const routes = (autoApprovers.routes ?? {}) as Record<string, string[]>;
  const existing = routes[route] ?? [];
  if (existing.includes(tag)) return policy;
  return {
    ...policy,
    autoApprovers: {
      ...autoApprovers,
      routes: { ...routes, [route]: [...existing, tag] },
    },
  };
};

// =============================================================================
// ACL Rules — Pure Helpers for Managing `acls` Access Rules
// =============================================================================

interface AclRule {
  action: string;
  src: string[];
  dst: string[];
  [key: string]: unknown;
}

/**
 * Returns true if there is already an accept rule where `src` contains the
 * given source member and `dst` contains the given destination.
 */
export const isAclRuleConfigured = (
  policy: Record<string, unknown> | null,
  src: string,
  dst: string,
): boolean => {
  if (!policy) return false;
  const acls = policy.acls as AclRule[] | undefined;
  if (!Array.isArray(acls)) return false;
  return acls.some(
    (rule) =>
      rule.action === "accept" &&
      Array.isArray(rule.src) && rule.src.includes(src) &&
      Array.isArray(rule.dst) && rule.dst.includes(dst),
  );
};

/**
 * Returns a new policy with an accept rule `src → dst` appended to `acls`.
 * No-op if an identical rule already exists.
 */
export const patchAclRule = (
  policy: Record<string, unknown>,
  src: string,
  dst: string,
): Record<string, unknown> => {
  if (isAclRuleConfigured(policy, src, dst)) return policy;
  const acls = (policy.acls ?? []) as AclRule[];
  return {
    ...policy,
    acls: [...acls, { action: "accept", src: [src], dst: [dst] }],
  };
};

/**
 * Returns a new policy with all accept rules matching `src → dst` removed from `acls`.
 * No-op if no such rule exists.
 */
export const unpatchAclRule = (
  policy: Record<string, unknown>,
  src: string,
  dst: string,
): Record<string, unknown> => {
  const acls = policy.acls as AclRule[] | undefined;
  if (!Array.isArray(acls)) return policy;
  const filtered = acls.filter(
    (rule) =>
      !(
        rule.action === "accept" &&
        Array.isArray(rule.src) && rule.src.includes(src) &&
        Array.isArray(rule.dst) && rule.dst.includes(dst)
      ),
  );
  if (filtered.length === acls.length) return policy;
  return { ...policy, acls: filtered };
};

// =============================================================================
// ACL Policy Un-patching (Pure) — inverse of the patch helpers above
// =============================================================================

/**
 * Returns a new policy with the given tag removed from tagOwners.
 * No-op if the tag is not present.
 */
export const unpatchTagOwner = (
  policy: Record<string, unknown>,
  tag: string,
): Record<string, unknown> => {
  const tagOwners = policy.tagOwners as Record<string, string[]> | undefined;
  if (!tagOwners || !(tag in tagOwners)) return policy;
  const { [tag]: _, ...rest } = tagOwners;
  const hasKeys = Object.keys(rest).length > 0;
  return hasKeys
    ? { ...policy, tagOwners: rest }
    : { ...policy, tagOwners: {} };
};

/**
 * Returns a new policy with the given tag removed from all autoApprovers routes.
 * If a route's approver list becomes empty after removal, the route entry is dropped.
 */
export const unpatchAutoApprover = (
  policy: Record<string, unknown>,
  tag: string,
): Record<string, unknown> => {
  const autoApprovers = policy.autoApprovers as
    | Record<string, unknown>
    | undefined;
  if (!autoApprovers) return policy;

  const routes = autoApprovers.routes as Record<string, string[]> | undefined;
  if (!routes) return policy;

  const cleaned: Record<string, string[]> = {};
  let changed = false;

  for (const [route, approvers] of Object.entries(routes)) {
    if (!Array.isArray(approvers)) {
      cleaned[route] = approvers;
      continue;
    }
    const filtered = approvers.filter((a) => a !== tag);
    if (filtered.length !== approvers.length) changed = true;
    if (filtered.length > 0) cleaned[route] = filtered;
  }

  if (!changed) return policy;

  return {
    ...policy,
    autoApprovers: {
      ...autoApprovers,
      routes: cleaned,
    },
  };
};
