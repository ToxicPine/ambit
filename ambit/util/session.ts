// =============================================================================
// Session — Shared Prerequisites Initialization
// =============================================================================

import { createFlyProvider, type FlyProvider } from "@/providers/fly.ts";
import {
  createTailscaleProvider,
  type TailscaleProvider,
} from "@/providers/tailscale.ts";
import type { Output } from "@/lib/output.ts";
import { checkDependencies } from "@/util/credentials.ts";
import { resolveOrg } from "@/util/resolve.ts";

/**
 * Bootstrap the three shared prerequisites every command needs:
 * validates fly CLI + Tailscale key, authenticates with Fly, and resolves org.
 */
export const initSession = async <T extends Record<string, unknown>>(
  out: Output<T>,
  opts: { json: boolean; org?: string },
): Promise<{ fly: FlyProvider; tailscale: TailscaleProvider; org: string }> => {
  const { tailscaleKey } = await checkDependencies(out);
  const fly = createFlyProvider();
  await fly.auth.login({ interactive: !opts.json });
  const tailscale = createTailscaleProvider(tailscaleKey);
  const org = await resolveOrg(fly, opts, out);
  return { fly, tailscale, org };
};
