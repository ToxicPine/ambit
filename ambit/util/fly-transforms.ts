// =============================================================================
// Fly Transforms — Pure Data Transformations
// =============================================================================

import type { FlyMachine } from "@/schemas/fly.ts";
import { type FlyMachineGuestSchema } from "@/schemas/fly.ts";
import type { z } from "zod";

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

// =============================================================================
// Machine Result Mapping
// =============================================================================

import type { MachineResult } from "@/providers/fly.ts";

/** Map raw Fly machines to internal MachineResult format. */
export const mapMachines = (raw: FlyMachine[]): MachineResult[] => {
  return raw.map((m: FlyMachine): MachineResult => ({
    id: m.id,
    state: mapFlyMachineState(m.state),
    size: mapFlyMachineSize(m.config?.guest),
    region: m.region,
    privateIp: m.private_ip,
  }));
};

// =============================================================================
// Size Config
// =============================================================================

import type { MachineSize } from "@/providers/fly.ts";

export const getSizeConfig = (
  size: MachineSize,
): { cpus: number; memoryMb: number } => {
  switch (size) {
    case "shared-cpu-1x":
      return { cpus: 1, memoryMb: 1024 };
    case "shared-cpu-2x":
      return { cpus: 2, memoryMb: 2048 };
    case "shared-cpu-4x":
      return { cpus: 4, memoryMb: 4096 };
  }
};

// =============================================================================
// Error Detail Extraction
// =============================================================================

/**
 * Pull the last non-empty, non-decoration line from fly stderr.
 * Fly often prints progress lines then the actual error at the end.
 */
export const extractErrorDetail = (stderr: string): string => {
  const lines = stderr
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("-->") && l !== "Error");

  return lines[lines.length - 1] ?? "unknown error";
};

// =============================================================================
// Subnet Extraction
// =============================================================================

export const extractSubnet = (privateIp: string): string => {
  // privateIp format: fdaa:X:XXXX::Y
  // Extract first 3 hextets and append ::/48
  const parts = privateIp.split(":");
  return `${parts[0]}:${parts[1]}:${parts[2]}::/48`;
};
