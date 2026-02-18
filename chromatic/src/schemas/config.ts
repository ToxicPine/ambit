// =============================================================================
// Configuration Schema
// =============================================================================

import { z } from "zod";

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_REGION = "iad";
const DEFAULT_AUTO_STOP_SECONDS = 300;
const DEFAULT_MACHINE_SIZE = "shared-cpu-1x" as const;
const DEFAULT_MEMORY_MB = 1024;
const DEFAULT_NETWORK = "browsers";

// =============================================================================
// Machine Size
// =============================================================================

export const MachineSizeEnum = z.enum([
  "shared-cpu-1x",
  "shared-cpu-2x",
  "shared-cpu-4x",
]);

export type MachineSize = z.infer<typeof MachineSizeEnum>;

// =============================================================================
// Instance Defaults
// =============================================================================

export const InstanceDefaultsSchema = z.object({
  autoStopSeconds: z.number(),
  machineSize: MachineSizeEnum,
  memoryMb: z.number(),
});

export type InstanceDefaults = z.infer<typeof InstanceDefaultsSchema>;

// =============================================================================
// Minimal Configuration
// =============================================================================

const ConfigSchema = z.object({
  network: z.string().default(DEFAULT_NETWORK),
  defaults: InstanceDefaultsSchema.optional(),
});

type Config = z.infer<typeof ConfigSchema>;

// =============================================================================
// Default Values
// =============================================================================

export const getDefaultInstanceDefaults = (): InstanceDefaults => ({
  autoStopSeconds: DEFAULT_AUTO_STOP_SECONDS,
  machineSize: DEFAULT_MACHINE_SIZE,
  memoryMb: DEFAULT_MEMORY_MB,
});

export const getDefaultRegion = (): string => DEFAULT_REGION;

// =============================================================================
// Config Directory
// =============================================================================

export const getConfigDir = (): string => {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
  return `${home}/.config/chromatic`;
};

export const getConfigPath = (): string => {
  return `${getConfigDir()}/config.json`;
};

export const ensureConfigDir = async (): Promise<void> => {
  const dir = getConfigDir();
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch {
    // Ignore - already exists
  }
};

// =============================================================================
// Config File Operations
// =============================================================================

export interface LoadedConfig {
  network: string;
  defaults: InstanceDefaults;
}

export const loadConfig = async (): Promise<LoadedConfig> => {
  const path = getConfigPath();
  const fallback: LoadedConfig = {
    network: DEFAULT_NETWORK,
    defaults: getDefaultInstanceDefaults(),
  };

  try {
    const content = await Deno.readTextFile(path);
    const data = JSON.parse(content);
    const result = ConfigSchema.safeParse(data);
    if (!result.success) return fallback;
    return {
      network: result.data.network,
      defaults: result.data.defaults ?? getDefaultInstanceDefaults(),
    };
  } catch {
    return fallback;
  }
};

export const saveConfig = async (config: {
  network: string;
  defaults?: InstanceDefaults;
}): Promise<void> => {
  await ensureConfigDir();
  const path = getConfigPath();
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + "\n");
};
