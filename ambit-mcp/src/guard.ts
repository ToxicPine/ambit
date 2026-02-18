// =============================================================================
// ambit-mcp: Safety Guards
// =============================================================================
// Protection layer for safe mode:
//   - assertNotRouter: prevents operations on ambit-* infrastructure apps
//   - auditDeploy: post-deploy check that releases public IPs and reports
// =============================================================================

import { exec, execJson } from "./exec.ts";
import { FlyIpListSchema } from "./schemas.ts";

/**
 * Throws if the app name targets a ambit infrastructure app.
 * Used by safe-mode handlers to prevent accidental router modification.
 */
export function assertNotRouter(app: string): void {
  if (app.startsWith("ambit-")) {
    throw new Error(
      "Cannot operate on ambit infrastructure apps (ambit-* prefix). " +
      "Use the ambit CLI to manage routers.",
    );
  }
}

export interface DeployAuditResult {
  public_ips_released: number;
  flycast_allocations: Array<{ address: string; network: string }>;
  warnings: string[];
}

/**
 * Post-deploy audit: enumerate IPs, release any public ones, report Flycast allocations.
 * Returns an audit result that gets included in the deploy tool's structuredContent.
 */
export async function auditDeploy(app: string): Promise<DeployAuditResult> {
  const result: DeployAuditResult = {
    public_ips_released: 0,
    flycast_allocations: [],
    warnings: [],
  };

  // Phase 1: Check and clean IPs
  const ips = await execJson(
    ["ips", "list", "-a", app, "--json"],
    FlyIpListSchema,
  );

  for (const ip of ips) {
    if (ip.Type === "private_v6") {
      result.flycast_allocations.push({
        address: ip.Address,
        network: ip.Network || "default",
      });
    } else {
      // Public IP found — release immediately
      await exec(["ips", "release", ip.Address, "-a", app, "--yes"]);
      result.public_ips_released++;
    }
  }

  // Phase 2: Inspect merged config for dangerous patterns
  try {
    const configResult = await exec(["config", "show", "-a", app]);
    if (configResult.success && configResult.stdout) {
      const parsed = JSON.parse(configResult.stdout);

      // Check for services that would be public if a public IP were added
      if (parsed.services?.length > 0) {
        const hasTlsHandler = parsed.services.some(
          (svc: { ports?: Array<{ handlers?: string[]; port?: number }> }) =>
            svc.ports?.some((p) =>
              p.handlers?.includes("tls") && p.port === 443
            ),
        );
        if (hasTlsHandler) {
          result.warnings.push(
            "Service config has TLS handler on port 443. " +
            "Safe only because no public IPs are allocated.",
          );
        }
      }

      // Check for force_https which implies public expectation
      if (parsed.http_service?.force_https) {
        result.warnings.push(
          "http_service.force_https is enabled. Has no effect on Flycast " +
          "and suggests config was written for public deployment.",
        );
      }
    }
  } catch {
    // Config inspection is best-effort; don't fail the audit
    result.warnings.push("Could not inspect merged config.");
  }

  // Phase 3: Verify Flycast allocation exists
  if (result.flycast_allocations.length === 0) {
    result.warnings.push(
      "No Flycast IP allocated. App is not reachable via Flycast. " +
      "Use fly_ip_allocate_flycast to allocate one.",
    );
  }

  return result;
}
