// =============================================================================
// Fly.io CLI Response Schemas
// =============================================================================

import { z } from "zod";

// =============================================================================
// Auth Response
// =============================================================================

export const FlyAuthSchema = z.object({
  email: z.string(),
}).loose();

export type FlyAuth = z.infer<typeof FlyAuthSchema>;

// =============================================================================
// State Enums
// =============================================================================

/** App-level status from the Fly GraphQL API / REST API (AppState enum). */
export const FlyAppStatusEnum = z.enum(["deployed", "pending", "suspended"]);
export type FlyAppStatus = z.infer<typeof FlyAppStatusEnum>;

/**
 * Machine-level state from the Fly Machines API.
 * Persistent: created, started, stopped, suspended, failed
 * Transient: creating, starting, stopping, restarting, suspending, destroying,
 *            updating, replacing, launch_failed
 * Terminal: destroyed, replaced, migrated
 */
export const FlyMachineStateEnum = z.enum([
  "created",
  "started",
  "stopped",
  "suspended",
  "failed",
  "creating",
  "starting",
  "stopping",
  "restarting",
  "suspending",
  "destroying",
  "updating",
  "replacing",
  "launch_failed",
  "destroyed",
  "replaced",
  "migrated",
]);
export type FlyMachineState = z.infer<typeof FlyMachineStateEnum>;

// =============================================================================
// App Schemas
// =============================================================================

export const FlyAppSchema = z.object({
  Name: z.string(),
  Status: z.string(),
  Organization: z.object({
    Slug: z.string(),
  }).optional(),
}).loose();

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
}).loose();

export type FlyStatus = z.infer<typeof FlyStatusSchema>;

// =============================================================================
// Machine Schemas
// =============================================================================

export const FlyMachineGuestSchema = z.object({
  cpu_kind: z.string(),
  cpus: z.number(),
  memory_mb: z.number(),
}).loose();

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
        }).loose(),
      ).optional(),
      protocol: z.string().optional(),
      internal_port: z.number().optional(),
    }).loose(),
  ).optional(),
}).loose();

export const FlyMachineSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: FlyMachineStateEnum.catch("created"),
  region: z.string(),
  private_ip: z.string().optional(),
  config: FlyMachineConfigSchema.optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).loose();

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
}).loose();

export type FlyOrgs = z.infer<typeof FlyOrgsSchema>;

// =============================================================================
// IP Schemas
// =============================================================================

export const FlyIpNetworkSchema = z.object({
  Name: z.string(),
  Organization: z.object({ Slug: z.string() }).optional(),
}).loose();

export const FlyIpSchema = z.object({
  ID: z.string().optional(),
  Address: z.string(),
  Type: z.string(),
  Region: z.string().optional(),
  CreatedAt: z.string().optional(),
  Network: FlyIpNetworkSchema.optional(),
}).loose();

export type FlyIp = z.infer<typeof FlyIpSchema>;

export const FlyIpListSchema = z.array(FlyIpSchema);

// =============================================================================
// REST API Schemas (Machines API - api.machines.dev)
// =============================================================================

export const FlyAppInfoSchema = z.object({
  name: z.string(),
  network: z.string(),
  status: FlyAppStatusEnum.catch("pending"),
  machine_count: z.number().optional(),
  organization: z.object({ slug: z.string() }).optional(),
}).loose();

export type FlyAppInfo = z.infer<typeof FlyAppInfoSchema>;

export const FlyAppInfoListSchema = z.object({
  total_apps: z.number(),
  apps: z.array(FlyAppInfoSchema),
}).loose();
