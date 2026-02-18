// =============================================================================
// ambit-mcp: Configuration Loader
// =============================================================================
// Reads ~/.config/ambit/config.json for default network/org settings.
// Returns null if the file doesn't exist (ambit not yet deployed).
// =============================================================================

import { join } from "@std/path";
import { z } from "@zod/zod";

const ConfigSchema = z.object({
  network: z.string(),
  router: z.object({
    appName: z.string(),
    tailscaleIp: z.string().optional(),
  }).optional(),
  fly: z.object({
    org: z.string(),
    region: z.string().optional(),
  }).optional(),
}).passthrough();

export type ambitConfig = z.infer<typeof ConfigSchema>;

/**
 * Load ambit config from ~/.config/ambit/config.json.
 * Returns null if the file doesn't exist or is invalid.
 */
export async function loadConfig(): Promise<ambitConfig | null> {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  const configPath = join(home, ".config", "ambit", "config.json");
  try {
    const text = await Deno.readTextFile(configPath);
    const json = JSON.parse(text);
    return ConfigSchema.parse(json);
  } catch {
    return null;
  }
}

/** Get the default org from config, or undefined. */
export function getDefaultOrg(config: ambitConfig | null): string | undefined {
  return config?.fly?.org;
}

/** Get the default network from config, or undefined. */
export function getDefaultNetwork(
  config: ambitConfig | null,
): string | undefined {
  return config?.network;
}
