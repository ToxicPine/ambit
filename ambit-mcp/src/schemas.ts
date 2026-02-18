// =============================================================================
// ambit-mcp: Zod Schemas for Fly CLI JSON Output
// =============================================================================
// Lenient schemas using .passthrough() — we parse what we need and ignore
// extra fields the CLI may add in future versions.
// =============================================================================

import { z } from "@zod/zod";

// --- fly auth whoami --json ---
export const FlyAuthSchema = z.object({
  email: z.string(),
}).passthrough();

// --- fly apps list --json (PascalCase) ---
export const FlyAppInfoSchema = z.object({
  ID: z.string(),
  Name: z.string(),
  Status: z.string(),
  Deployed: z.boolean(),
  Hostname: z.string(),
  Organization: z.object({ Slug: z.string() }).passthrough(),
  Network: z.string().optional(),
}).passthrough();

export const FlyAppListSchema = z.array(FlyAppInfoSchema);

// --- fly status --json (PascalCase, machines nested) ---
export const FlyStatusMachineSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  state: z.string(),
  region: z.string(),
  private_ip: z.string().optional(),
}).passthrough();

export const FlyAppStatusSchema = z.object({
  ID: z.string(),
  Name: z.string(),
  Status: z.string(),
  Deployed: z.boolean(),
  Hostname: z.string(),
  Machines: z.array(FlyStatusMachineSchema).optional(),
}).passthrough();

// --- fly machines list --json (snake_case) ---
export const FlyMachineSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  state: z.string(),
  region: z.string(),
  private_ip: z.string().optional(),
  config: z.object({
    guest: z.object({
      cpu_kind: z.string().optional(),
      cpus: z.number().optional(),
      memory_mb: z.number().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

export const FlyMachineListSchema = z.array(FlyMachineSchema);

// --- fly ips list --json (PascalCase) ---
export const FlyIpSchema = z.object({
  ID: z.string().optional(),
  Address: z.string(),
  Type: z.string(),
  Region: z.string().optional(),
  CreatedAt: z.string().optional(),
  Network: z.string().optional(),
}).passthrough();

export const FlyIpListSchema = z.array(FlyIpSchema);

// --- fly secrets list --json (PascalCase) ---
export const FlySecretSchema = z.object({
  Name: z.string(),
  Digest: z.string(),
  CreatedAt: z.string(),
}).passthrough();

export const FlySecretListSchema = z.array(FlySecretSchema);

// --- fly volumes list --json (snake_case) ---
export const FlyVolumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  size_gb: z.number(),
  region: z.string(),
  encrypted: z.boolean(),
  attached_machine_id: z.string().nullable().optional(),
}).passthrough();

export const FlyVolumeListSchema = z.array(FlyVolumeSchema);

// --- fly scale show --json (PascalCase) ---
export const FlyScaleProcessSchema = z.object({
  Process: z.string(),
  Count: z.number(),
  CPUKind: z.string(),
  CPUs: z.number(),
  Memory: z.number(),
  Regions: z.record(z.string(), z.number()).optional(),
}).passthrough();

export const FlyScaleShowSchema = z.array(FlyScaleProcessSchema);

// --- fly logs --json --no-tail (one JSON object per line, snake_case) ---
export const FlyLogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.string().optional(),
  message: z.string(),
  region: z.string().optional(),
  instance: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

// --- fly ips allocate-v6 output (PascalCase, single object) ---
export const FlyIpAllocateSchema = FlyIpSchema;

// --- fly volumes create --json (snake_case, single object) ---
export const FlyVolumeCreateSchema = FlyVolumeSchema;

// --- fly certs list --json (PascalCase) ---
export const FlyCertSchema = z.object({
  Hostname: z.string(),
  CreatedAt: z.string().optional(),
}).passthrough();

export const FlyCertListSchema = z.array(FlyCertSchema);
