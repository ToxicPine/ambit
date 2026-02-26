// =============================================================================
// Credential Store - Persistent Tailscale API Key Storage
// =============================================================================

import { z } from "zod";
import { commandExists, ensureConfigDir, fileExists, getConfigDir } from "@/lib/cli.ts";
import { ENV_TAILSCALE_API_KEY, FLYCTL_INSTALL_URL } from "@/util/constants.ts";

// =============================================================================
// Schema
// =============================================================================

const CredentialsSchema = z.object({
  apiKey: z.string(),
});

// =============================================================================
// Credential Store Interface
// =============================================================================

export interface CredentialStore {
  getTailscaleApiKey(): Promise<string | null>;
  setTailscaleApiKey(key: string): Promise<void>;
}

// =============================================================================
// Config File Implementation
// =============================================================================

const getCredentialsPath = (): string => `${getConfigDir()}/credentials.json`;

export const createConfigCredentialStore = (): CredentialStore => {
  return {
    async getTailscaleApiKey(): Promise<string | null> {
      const path = getCredentialsPath();
      if (!(await fileExists(path))) {
        return null;
      }

      try {
        const content = await Deno.readTextFile(path);
        const result = CredentialsSchema.safeParse(JSON.parse(content));
        return result.success ? result.data.apiKey : null;
      } catch {
        return null;
      }
    },

    async setTailscaleApiKey(key: string): Promise<void> {
      await ensureConfigDir();
      const path = getCredentialsPath();
      await Deno.writeTextFile(
        path,
        JSON.stringify({ apiKey: key }, null, 2) + "\n",
      );
    },
  };
};

// =============================================================================
// Default Credential Store (env var → file)
// =============================================================================

export const getCredentialStore = (): CredentialStore => {
  const fileStore = createConfigCredentialStore();

  return {
    async getTailscaleApiKey(): Promise<string | null> {
      const envKey = Deno.env.get(ENV_TAILSCALE_API_KEY);
      if (envKey) return envKey;

      return await fileStore.getTailscaleApiKey();
    },

    async setTailscaleApiKey(key: string): Promise<void> {
      await fileStore.setTailscaleApiKey(key);
    },
  };
};

// =============================================================================
// Check Dependencies (batch validation)
// =============================================================================

/**
 * Verify that flyctl CLI and Tailscale API key are both available.
 * Reports ALL missing dependencies before dying, so the user can
 * fix everything in one pass instead of hitting errors one at a time.
 *
 * Returns the validated Tailscale API key for explicit injection into
 * the provider created by the caller.
 */
export const checkDependencies = async (
  out: { err(msg: string): unknown; die(msg: string): never },
): Promise<{ tailscaleKey: string }> => {
  const errors: string[] = [];

  if (!(await commandExists("fly"))) {
    errors.push(
      "Flyctl Not Found. Install from https://fly.io/docs/flyctl/install/",
    );
  }

  const key = await getCredentialStore().getTailscaleApiKey();
  if (!key) {
    errors.push(
      "Tailscale API Key Required. Run 'ambit create' or set TAILSCALE_API_KEY",
    );
  }

  if (errors.length === 1) {
    return out.die(errors[0]);
  }
  if (errors.length > 1) {
    for (const e of errors) out.err(e);
    return out.die("Missing Prerequisites");
  }

  return { tailscaleKey: key! };
};
