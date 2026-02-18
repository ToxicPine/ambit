// =============================================================================
// Fly.io CLI Response Schemas
// =============================================================================

import { z } from "zod";

// =============================================================================
// Auth Response
// =============================================================================

export const FlyAuthSchema = z.object({
  email: z.string(),
}).passthrough();

export type FlyAuth = z.infer<typeof FlyAuthSchema>;

// =============================================================================
// App Schemas
// =============================================================================

export const FlyAppSchema = z.object({
  Name: z.string(),
  Status: z.string(),
  Organization: z.object({
    Slug: z.string(),
  }).optional(),
}).passthrough();

export type FlyApp = z.infer<typeof FlyAppSchema>;

export const FlyAppsListSchema = z.array(FlyAppSchema);

// =============================================================================
// App Status
// =============================================================================

export const FlyStatusSchema = z.object({
  ID: z.string(),
  Name: z.string().optional(),
  Hostname: z.string().optional(),
  Deployed: z.boolean().optional(),
}).passthrough();

export type FlyStatus = z.infer<typeof FlyStatusSchema>;

// =============================================================================
// Machine Schemas
// =============================================================================

export const FlyMachineGuestSchema = z.object({
  cpu_kind: z.string(),
  cpus: z.number(),
  memory_mb: z.number(),
}).passthrough();

export const FlyMachineConfigSchema = z.object({
  guest: FlyMachineGuestSchema.optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  auto_destroy: z.boolean().optional(),
  services: z.array(
    z.object({
      ports: z.array(
        z.object({
          port: z.number(),
          handlers: z.array(z.string()).optional(),
        }).passthrough(),
      ).optional(),
      protocol: z.string().optional(),
      internal_port: z.number().optional(),
    }).passthrough(),
  ).optional(),
}).passthrough();

export const FlyMachineSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  region: z.string(),
  private_ip: z.string().optional(),
  config: FlyMachineConfigSchema.optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();

export type FlyMachine = z.infer<typeof FlyMachineSchema>;

export const FlyMachinesListSchema = z.array(FlyMachineSchema);

// =============================================================================
// Organization Schemas
// =============================================================================

export const FlyOrgsSchema = z.record(z.string(), z.string());

// =============================================================================
// Deploy Schemas
// =============================================================================

export const FlyDeploySchema = z.object({
  ID: z.string().optional(),
  Status: z.string().optional(),
}).passthrough();

// =============================================================================
// Machine State Mapping
// =============================================================================

/**
 * Map Fly machine state to internal state.
 * Fly states: created, starting, started, stopping, stopped, destroying, destroyed
 */
export const mapFlyMachineState = (
  flyState: string,
): "creating" | "running" | "frozen" | "failed" => {
  switch (flyState.toLowerCase()) {
    case "started":
      return "running";
    case "stopped":
    case "suspended":
      return "frozen";
    case "created":
    case "starting":
      return "creating";
    case "destroying":
    case "destroyed":
    case "failed":
      return "failed";
    default:
      return "creating";
  }
};

// =============================================================================
// Machine Size Mapping
// =============================================================================

/**
 * Map Fly guest config to machine size enum.
 */
export const mapFlyMachineSize = (
  guest?: z.infer<typeof FlyMachineGuestSchema>,
): "shared-cpu-1x" | "shared-cpu-2x" | "shared-cpu-4x" => {
  if (!guest) return "shared-cpu-1x";

  const cpus = guest.cpus;
  if (cpus >= 4) return "shared-cpu-4x";
  if (cpus >= 2) return "shared-cpu-2x";
  return "shared-cpu-1x";
};

export type FlyOrgs = z.infer<typeof FlyOrgsSchema>;

// =============================================================================
// IP Schemas
// =============================================================================

export const FlyIpNetworkSchema = z.object({
  Name: z.string(),
  Organization: z.object({ Slug: z.string() }).optional(),
}).passthrough();

export const FlyIpSchema = z.object({
  ID: z.string().optional(),
  Address: z.string(),
  Type: z.string(),
  Region: z.string().optional(),
  CreatedAt: z.string().optional(),
  Network: FlyIpNetworkSchema.optional(),
}).passthrough();

export type FlyIp = z.infer<typeof FlyIpSchema>;

export const FlyIpListSchema = z.array(FlyIpSchema);

// =============================================================================
// REST API Schemas (Machines API - api.machines.dev)
// =============================================================================

export const FlyAppInfoSchema = z.object({
  name: z.string(),
  network: z.string(),
  status: z.string(),
  organization: z.object({ slug: z.string() }).optional(),
}).passthrough();

export type FlyAppInfo = z.infer<typeof FlyAppInfoSchema>;

export const FlyAppInfoListSchema = z.object({
  total_apps: z.number(),
  apps: z.array(FlyAppInfoSchema),
}).passthrough();
