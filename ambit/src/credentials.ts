// =============================================================================
// Credential Store - Persistent Tailscale API Key Storage
// =============================================================================

import { z } from "zod";
import { ensureConfigDir, fileExists } from "../lib/cli.ts";
import { getConfigDir } from "./schemas/config.ts";
import {
  createTailscaleProvider,
  type TailscaleProvider,
} from "./providers/tailscale.ts";

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
      // Environment variable takes priority
      const envKey = Deno.env.get("TAILSCALE_API_KEY");
      if (envKey) return envKey;

      return await fileStore.getTailscaleApiKey();
    },

    async setTailscaleApiKey(key: string): Promise<void> {
      await fileStore.setTailscaleApiKey(key);
    },
  };
};

// =============================================================================
// Require Tailscale Provider (fail-fast)
// =============================================================================

/** Get a TailscaleProvider or die via out.die(). Respects JSON mode. */
export const requireTailscaleProvider = async (
  out: { die(msg: string): never },
): Promise<TailscaleProvider> => {
  const store = getCredentialStore();
  const key = await store.getTailscaleApiKey();
  if (!key) {
    return out.die(
      "Tailscale API Key Required. Run 'ambit create' or set TAILSCALE_API_KEY",
    );
  }
  return createTailscaleProvider("-", key);
};
