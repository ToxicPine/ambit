// =============================================================================
// Safety Guards - Protection Layer for Workload Deploys
// =============================================================================
//
// Ported from ambit-mcp guard.ts, adapted to use CLI's FlyProvider.
//
//   - assertNotRouter: prevents operations on ambit-* infrastructure apps
//   - scanFlyToml: pre-flight TOML scan for dangerous patterns
//   - auditDeploy: post-deploy check that releases public IPs and reports
//
// =============================================================================

import { parse as parseToml } from "@std/toml";
import type { FlyProvider } from "./providers/fly.ts";

// =============================================================================
// Types
// =============================================================================

export interface PreflightResult {
  scanned: boolean;
  errors: string[];
  warnings: string[];
}

export interface DeployAuditResult {
  public_ips_released: number;
  flycast_allocations: Array<{ address: string; network: string }>;
  warnings: string[];
}

// =============================================================================
// assertNotRouter
// =============================================================================

/**
 * Throws if the app name targets an ambit infrastructure app.
 * Workload apps must not start with the ambit- prefix.
 */
export function assertNotRouter(app: string): void {
  if (app.startsWith("ambit-")) {
    throw new Error(
      "Cannot deploy ambit infrastructure apps (ambit-* prefix). " +
        "Use 'ambit create' to manage routers.",
    );
  }
}

// =============================================================================
// scanFlyToml
// =============================================================================

/**
 * Pre-flight scan of fly.toml content for patterns that are dangerous
 * or nonsensical on a Flycast-only deployment.
 *
 * Errors are fatal (refuse to deploy). Warnings are informational.
 */
export function scanFlyToml(tomlContent: string): PreflightResult {
  const result: PreflightResult = {
    scanned: true,
    errors: [],
    warnings: [],
  };

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(tomlContent) as Record<string, unknown>;
  } catch {
    result.errors.push("Failed to parse fly.toml");
    return result;
  }

  // Check http_service.force_https — nonsensical on Flycast
  const httpService = parsed.http_service as
    | Record<string, unknown>
    | undefined;
  if (httpService?.force_https) {
    result.errors.push(
      "http_service.force_https is enabled. " +
        "This implies public HTTPS which is incompatible with Flycast-only deployment.",
    );
  }

  // Check [[services]] for TLS on 443 — dangerous if a public IP were ever added
  const services = parsed.services as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(services)) {
    result.warnings.push(
      "fly.toml uses [[services]] blocks. Consider migrating to [http_service].",
    );

    for (const svc of services) {
      const ports = svc.ports as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(ports)) continue;

      for (const port of ports) {
        const handlers = port.handlers as string[] | undefined;
        if (
          port.port === 443 &&
          Array.isArray(handlers) &&
          handlers.includes("tls")
        ) {
          result.errors.push(
            "Service has TLS handler on port 443. " +
              "This is designed for public HTTPS and incompatible with Flycast-only deployment.",
          );
        }
      }
    }
  }

  return result;
}

// =============================================================================
// auditDeploy
// =============================================================================

/**
 * Post-deploy audit: enumerate IPs, release any public ones, inspect merged
 * config, and verify Flycast allocation on the target network.
 */
export async function auditDeploy(
  fly: FlyProvider,
  app: string,
  targetNetwork: string,
): Promise<DeployAuditResult> {
  const result: DeployAuditResult = {
    public_ips_released: 0,
    flycast_allocations: [],
    warnings: [],
  };

  // Phase 1: Check and clean IPs — only keep Flycast on the target network
  const ips = await fly.listIps(app);

  for (const ip of ips) {
    const ipNetwork = ip.Network?.Name || "default";

    if (ip.Type === "private_v6" && ipNetwork === targetNetwork) {
      // Flycast on the correct network — keep it
      result.flycast_allocations.push({
        address: ip.Address,
        network: ipNetwork,
      });
    } else if (ip.Type === "private_v6") {
      // Flycast on wrong network (e.g. default from --flycast flag) — release
      await fly.releaseIp(app, ip.Address);
      result.warnings.push(
        `Released Flycast IP ${ip.Address} on wrong network '${ipNetwork}' (expected '${targetNetwork}')`,
      );
    } else {
      // Public IP — release immediately
      await fly.releaseIp(app, ip.Address);
      result.public_ips_released++;
    }
  }

  // Phase 2: Inspect merged config for dangerous patterns
  const config = await fly.getConfig(app);
  if (config) {
    const services = config.services as
      | Array<{
        ports?: Array<{ handlers?: string[]; port?: number }>;
      }>
      | undefined;

    if (Array.isArray(services) && services.length > 0) {
      const hasTlsHandler = services.some((svc) =>
        svc.ports?.some((p) => p.handlers?.includes("tls") && p.port === 443)
      );
      if (hasTlsHandler) {
        result.warnings.push(
          "Merged config has TLS handler on port 443. " +
            "Safe only because no public IPs are allocated.",
        );
      }
    }

    const httpService = config.http_service as
      | { force_https?: boolean }
      | undefined;
    if (httpService?.force_https) {
      result.warnings.push(
        "http_service.force_https is enabled. Has no effect on Flycast.",
      );
    }
  } else {
    result.warnings.push("Could not inspect merged config.");
  }

  // Phase 3: Verify Flycast allocation on target network
  const hasTargetFlycast = result.flycast_allocations.some(
    (a) => a.network === targetNetwork,
  );

  if (!hasTargetFlycast) {
    // Allocate on the target network
    await fly.allocateFlycastIp(app, targetNetwork);
    result.flycast_allocations.push({
      address: "(newly allocated)",
      network: targetNetwork,
    });
  }

  return result;
}
