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
import { getFlyIdentityKey } from "@/util/credentials.ts";
import { resolveOrg } from "@/util/resolve.ts";
import { commandExists } from "@/lib/cli.ts";

/**
 * Bootstrap the three shared prerequisites every command needs:
 * validates fly CLI + Tailscale key, authenticates with Fly, and resolves org.
 */
export const initSession = async <T extends Record<string, unknown>>(
  out: Output<T>,
  opts: { json: boolean; org?: string },
): Promise<{ fly: FlyProvider; tailscale: TailscaleProvider; org: string }> => {
  const fly = createFlyProvider();
  if (!(await commandExists("fly"))) {
    return out.die(
      "Flyctl Not Found. Install from https://fly.io/docs/flyctl/install/",
    );
  }
  const flyEmail = await fly.auth.login({ interactive: !opts.json });
  const org = await resolveOrg(fly, opts, out);
  await fly.auth.useOrgToken(org);
  const scope = getFlyIdentityKey(org, flyEmail);
  const { tailscaleKey } = await checkDependencies(out, scope);
  const tailscale = createTailscaleProvider(tailscaleKey);
  return { fly, tailscale, org };
};
