// =============================================================================
// Credential Store - Persistent Tailscale Token Storage
// =============================================================================

import { z } from "zod";
import {
  commandExists,
  ensureConfigDir,
  fileExists,
  getConfigDir,
} from "@/lib/cli.ts";
import { ENV_TAILSCALE_API_KEY } from "@/util/constants.ts";

// =============================================================================
// Schema
// =============================================================================

const CredentialsSchema = z.object({
  tailscaleApiKeys: z.record(z.string(), z.string()).optional(),
});

type CredentialsData = z.infer<typeof CredentialsSchema>;

export const getFlyIdentityKey = (
  org: string,
  flyEmail?: string | null,
): string => {
  const normalizedOrg = org.trim().toLowerCase();
  const normalizedEmail = flyEmail?.trim().toLowerCase();

  if (normalizedOrg === "personal" && normalizedEmail) {
    return `fly:user:${normalizedEmail}`;
  }

  return `fly:org:${normalizedOrg}`;
};

// =============================================================================
// Credential Store Interface
// =============================================================================

export interface CredentialStore {
  getTailscaleApiKey(scope: string): Promise<string | null>;
  setTailscaleApiKey(key: string, scope: string): Promise<void>;
  clear(): Promise<void>;
}

// =============================================================================
// Config File Implementation
// =============================================================================

const getCredentialsPath = (): string => `${getConfigDir()}/credentials.json`;

const readCredentials = async (): Promise<CredentialsData> => {
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
  data: CredentialsData,
): Promise<void> => {
  await ensureConfigDir();
  const path = getCredentialsPath();
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2) + "\n");
};

export const createConfigCredentialStore = (): CredentialStore => {
  return {
    async getTailscaleApiKey(scope: string): Promise<string | null> {
      const data = await readCredentials();
      return data.tailscaleApiKeys?.[scope] ?? null;
    },

    async setTailscaleApiKey(key: string, scope: string): Promise<void> {
      const data = await readCredentials();
      data.tailscaleApiKeys = {
        ...(data.tailscaleApiKeys ?? {}),
        [scope]: key,
      };
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
// Default Credential Store (env var -> file)
// =============================================================================

export const getCredentialStore = (): CredentialStore => {
  const fileStore = createConfigCredentialStore();

  return {
    async getTailscaleApiKey(scope: string): Promise<string | null> {
      const envKey = Deno.env.get(ENV_TAILSCALE_API_KEY);
      if (envKey) return envKey;

      return await fileStore.getTailscaleApiKey(scope);
    },

    async setTailscaleApiKey(key: string, scope: string): Promise<void> {
      await fileStore.setTailscaleApiKey(key, scope);
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
  scope: string,
): Promise<{ tailscaleKey: string }> => {
  const errors: string[] = [];

  if (!(await commandExists("fly"))) {
    errors.push(
      "Flyctl Not Found. Install from https://fly.io/docs/flyctl/install/",
    );
  }

  const credentials = getCredentialStore();

  const key = await credentials.getTailscaleApiKey(scope);
  if (!key) {
    errors.push(
      "Tailscale API Key Required for This Fly Organization. Run 'ambit auth login --org <org>' or set TAILSCALE_API_KEY",
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
