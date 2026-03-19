// =============================================================================
// Credential Store - Persistent Tailscale & Fly.io Token Storage
// =============================================================================

import { z } from "zod";
import {
  commandExists,
  ensureConfigDir,
  fileExists,
  getConfigDir,
} from "@/lib/cli.ts";
import { ENV_FLY_API_TOKEN, ENV_TAILSCALE_API_KEY } from "@/util/constants.ts";

// =============================================================================
// Schema
// =============================================================================

const CredentialsSchema = z.object({
  apiKey: z.string().optional(),
  flyToken: z.string().optional(),
});

// =============================================================================
// Credential Store Interface
// =============================================================================

export interface CredentialStore {
  getTailscaleApiKey(): Promise<string | null>;
  setTailscaleApiKey(key: string): Promise<void>;
  getFlyToken(): Promise<string | null>;
  setFlyToken(token: string): Promise<void>;
  clear(): Promise<void>;
}

// =============================================================================
// Config File Implementation
// =============================================================================

const getCredentialsPath = (): string => `${getConfigDir()}/credentials.json`;

const readCredentials = async (): Promise<
  { apiKey?: string; flyToken?: string }
> => {
  const path = getCredentialsPath();
  if (!(await fileExists(path))) return {};

  try {
    const content = await Deno.readTextFile(path);
    const result = CredentialsSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : {};
  } catch {
    return {};
  }
};

const writeCredentials = async (
  data: { apiKey?: string; flyToken?: string },
): Promise<void> => {
  await ensureConfigDir();
  const path = getCredentialsPath();
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2) + "\n");
};

export const createConfigCredentialStore = (): CredentialStore => {
  return {
    async getTailscaleApiKey(): Promise<string | null> {
      const data = await readCredentials();
      return data.apiKey ?? null;
    },

    async setTailscaleApiKey(key: string): Promise<void> {
      const data = await readCredentials();
      data.apiKey = key;
      await writeCredentials(data);
    },

    async getFlyToken(): Promise<string | null> {
      const data = await readCredentials();
      return data.flyToken ?? null;
    },

    async setFlyToken(token: string): Promise<void> {
      const data = await readCredentials();
      data.flyToken = token;
      await writeCredentials(data);
    },

    async clear(): Promise<void> {
      const path = getCredentialsPath();
      try {
        await Deno.remove(path);
      } catch {
        // File may not exist
      }
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

    async getFlyToken(): Promise<string | null> {
      const envToken = Deno.env.get(ENV_FLY_API_TOKEN);
      if (envToken) return envToken;

      return await fileStore.getFlyToken();
    },

    async setFlyToken(token: string): Promise<void> {
      await fileStore.setFlyToken(token);
    },

    async clear(): Promise<void> {
      await fileStore.clear();
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
): Promise<{ tailscaleKey: string; flyToken: string | null }> => {
  const errors: string[] = [];

  if (!(await commandExists("fly"))) {
    errors.push(
      "Flyctl Not Found. Install from https://fly.io/docs/flyctl/install/",
    );
  }

  const credentials = getCredentialStore();

  const key = await credentials.getTailscaleApiKey();
  if (!key) {
    errors.push(
      "Tailscale API Key Required. Run 'ambit auth login' or set TAILSCALE_API_KEY",
    );
  }

  let flyToken = await credentials.getFlyToken();
  if (!flyToken) {
    // Adopt token from flyctl's own config if available
    const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
    const configPath = `${home}/.fly/config.yml`;
    if (await fileExists(configPath)) {
      try {
        const content = await Deno.readTextFile(configPath);
        const match = content.match(/access_token:\s*(.+)/);
        if (match?.[1]) {
          const adopted = match[1].trim();
          await credentials.setFlyToken(adopted);
          flyToken = adopted;
        }
      } catch {
        // Ignore read errors
      }
    }
  }
  if (!flyToken) {
    errors.push(
      "Fly.io Token Required. Run 'ambit auth login' or set FLY_API_TOKEN",
    );
  }

  if (errors.length === 1) {
    return out.die(errors[0]);
  }
  if (errors.length > 1) {
    for (const e of errors) out.err(e);
    return out.die("Missing Prerequisites");
  }

  return { tailscaleKey: key!, flyToken };
};
