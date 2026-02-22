// =============================================================================
// ambit-mcp: Tool Handlers
// =============================================================================
// Each handler: parse args → build flyctl command → exec → normalize → return
// structuredContent. Safe-mode handlers call guards; unsafe-mode handlers don't.
// =============================================================================

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Mode } from "./tools.ts";
import { exec, execJson, execNdjson } from "./exec.ts";
import { getDefaultNetwork, getDefaultOrg, loadConfig } from "./config.ts";
import { assertNotRouter, auditDeploy } from "./guard.ts";
import {
  FlyAppListSchema,
  FlyAppStatusSchema,
  FlyAuthSchema,
  FlyCertListSchema,
  FlyIpAllocateSchema,
  FlyIpListSchema,
  FlyLogEntrySchema,
  FlyMachineListSchema,
  FlyScaleShowSchema,
  FlySecretListSchema,
  FlyVolumeCreateSchema,
  FlyVolumeListSchema,
} from "./schemas.ts";

// @cardelli/ambit — safe imports (pure functions / no die() calls)
import { extractSubnet, getRouterTag } from "@cardelli/ambit/schemas/config";
import { getRouterAppName } from "@cardelli/ambit/providers/fly";
import {
  isAcceptRoutesEnabled,
  isTailscaleInstalled,
} from "@cardelli/ambit/providers/tailscale";
import { randomId } from "@cardelli/ambit/lib/cli";
import { getRouterDockerDir } from "@cardelli/ambit/lib/paths";
import { getCredentialStore } from "@cardelli/ambit/src/credentials";
import { runCommand } from "@cardelli/ambit/lib/command";
import { fetchTemplate, parseTemplateRef } from "@cardelli/ambit/src/template";

// MCP-safe Tailscale client (throws instead of die())
import { createTailscaleClient, waitForDevice } from "./tailscale.ts";

// =============================================================================
// Helpers
// =============================================================================

// deno-lint-ignore no-explicit-any
type Args = Record<string, any>;

type Handler = (args: Args) => Promise<CallToolResult>;

/** Return a success result with both text content and structuredContent. */
function ok(text: string, data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: data,
  };
}

/** Return an error result (isError skips outputSchema validation). */
function err(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

/**
 * Resolve a template reference string into a local directory ready for deploy.
 * Returns the template dir path and a cleanup function, or a CallToolResult error.
 */
async function resolveTemplate(
  templateRef: string,
): Promise<
  { templateDir: string; tempDir: string } | { error: CallToolResult }
> {
  const ref = parseTemplateRef(templateRef);
  if (!ref) {
    return {
      error: err(
        `Invalid Template Reference: "${templateRef}". ` +
          `Format: owner/repo/path[@ref]`,
      ),
    };
  }

  const result = await fetchTemplate(ref);
  if (!result.ok) {
    return { error: err(`Template Fetch Failed: ${result.message}`) };
  }

  return { templateDir: result.templateDir, tempDir: result.tempDir };
}

// =============================================================================
// Handler Factory
// =============================================================================

export function createHandlers(mode: Mode): Record<string, Handler> {
  const safe = mode === "safe";

  /** Guard: in safe mode, block operations on ambit-* apps. */
  function guard(app: string): void {
    if (safe) assertNotRouter(app);
  }

  // =========================================================================
  // Auth
  // =========================================================================

  async function fly_auth_status(): Promise<CallToolResult> {
    try {
      const data = await execJson(["auth", "whoami", "--json"], FlyAuthSchema);
      return ok(`Authenticated as ${data.email}`, {
        authenticated: true,
        email: data.email,
      });
    } catch {
      return ok("Not Authenticated. Run 'fly auth login' in your terminal.", {
        authenticated: false,
      });
    }
  }

  // =========================================================================
  // Apps
  // =========================================================================

  async function fly_app_status(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const data = await execJson(
      ["status", "-a", args.app, "--json"],
      FlyAppStatusSchema,
    );
    const machines = (data.Machines ?? []).map((m) => ({
      id: m.id,
      name: m.name ?? "",
      state: m.state,
      region: m.region,
      private_ip: m.private_ip ?? "",
    }));
    return ok(`App ${data.Name}: ${data.Status}`, {
      id: data.ID,
      name: data.Name,
      status: data.Status,
      deployed: data.Deployed,
      hostname: data.Hostname,
      machines,
    });
  }

  async function fly_app_list(args: Args): Promise<CallToolResult> {
    const cmdArgs = ["apps", "list", "--json"];
    const org = args.org ?? getDefaultOrg(await loadConfig());
    if (org) cmdArgs.push("--org", org);

    let apps = await execJson(cmdArgs, FlyAppListSchema);

    // Safe mode: exclude ambit-* infrastructure apps
    if (safe) {
      apps = apps.filter((a) => !a.Name.startsWith("ambit-"));
    }

    const normalized = apps.map((a) => ({
      name: a.Name,
      status: a.Status,
      deployed: a.Deployed,
      hostname: a.Hostname,
      org: a.Organization.Slug,
    }));

    return ok(`${normalized.length} app(s)`, { apps: normalized });
  }

  async function fly_app_create(args: Args): Promise<CallToolResult> {
    const cmdArgs = ["apps", "create", args.name, "--json"];
    const config = await loadConfig();

    let network: string | undefined;
    if (safe) {
      // Safe mode: always use configured network
      network = getDefaultNetwork(config);
      if (!network) {
        return err(
          "No ambit network configured. Deploy a router first with " +
            "'ambit deploy' to create a network.",
        );
      }
    } else {
      network = args.network;
    }
    if (network) cmdArgs.push("--network", network);

    const org = args.org ?? getDefaultOrg(config);
    if (org) cmdArgs.push("--org", org);

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Failed to Create App: ${result.stderr || result.stdout}`);
    }

    return ok(`Created App ${args.name}`, {
      name: args.name,
      network,
      org: org ?? "",
    });
  }

  async function fly_app_destroy(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const result = await exec(["apps", "destroy", args.app, "--yes"]);
    if (!result.success) {
      return err(`Failed to Destroy App: ${result.stderr || result.stdout}`);
    }
    return ok(`Destroyed App ${args.app}`, { ok: true, app: args.app });
  }

  // =========================================================================
  // Machines
  // =========================================================================

  async function fly_machine_list(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const data = await execJson(
      ["machines", "list", "-a", args.app, "--json"],
      FlyMachineListSchema,
    );
    const machines = data.map((m) => ({
      id: m.id,
      name: m.name ?? "",
      state: m.state,
      region: m.region,
      private_ip: m.private_ip ?? "",
      cpu_kind: m.config?.guest?.cpu_kind,
      cpus: m.config?.guest?.cpus,
      memory_mb: m.config?.guest?.memory_mb,
    }));
    return ok(`${machines.length} machine(s)`, { machines });
  }

  async function fly_machine_start(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const result = await exec([
      "machines",
      "start",
      args.machine_id,
      "-a",
      args.app,
    ]);
    if (!result.success) {
      return err(`Failed to Start Machine: ${result.stderr || result.stdout}`);
    }
    return ok(`Started Machine ${args.machine_id}`, {
      ok: true,
      machine_id: args.machine_id,
    });
  }

  async function fly_machine_stop(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const result = await exec([
      "machines",
      "stop",
      args.machine_id,
      "-a",
      args.app,
    ]);
    if (!result.success) {
      return err(`Failed to Stop Machine: ${result.stderr || result.stdout}`);
    }
    return ok(`Stopped Machine ${args.machine_id}`, {
      ok: true,
      machine_id: args.machine_id,
    });
  }

  async function fly_machine_destroy(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const cmdArgs = ["machines", "destroy", args.machine_id, "-a", args.app];
    if (args.force) cmdArgs.push("--force");

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(
        `Failed to Destroy Machine: ${result.stderr || result.stdout}`,
      );
    }
    return ok(`Destroyed Machine ${args.machine_id}`, {
      ok: true,
      machine_id: args.machine_id,
    });
  }

  async function fly_machine_exec(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const cmdArgs = [
      "machine",
      "exec",
      args.machine_id,
      ...args.command,
      "-a",
      args.app,
    ];

    const result = await exec(cmdArgs);
    return ok(
      result.stdout || result.stderr || "(no output)",
      {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.code,
      },
    );
  }

  // =========================================================================
  // IPs
  // =========================================================================

  async function fly_ip_list(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const data = await execJson(
      ["ips", "list", "-a", args.app, "--json"],
      FlyIpListSchema,
    );
    const ips = data.map((ip) => ({
      address: ip.Address,
      type: ip.Type,
      region: ip.Region ?? "",
      network: ip.Network ?? "",
      created_at: ip.CreatedAt ?? "",
    }));
    return ok(`${ips.length} IP(s)`, { ips });
  }

  async function fly_ip_release(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const result = await exec([
      "ips",
      "release",
      args.address,
      "-a",
      args.app,
      "--yes",
    ]);
    if (!result.success) {
      return err(`Failed to Release IP: ${result.stderr || result.stdout}`);
    }
    return ok(`Released ${args.address}`, { ok: true, address: args.address });
  }

  async function fly_ip_allocate_flycast(args: Args): Promise<CallToolResult> {
    guard(args.app);
    // Safe mode: always --private --network <name>
    const result = await exec([
      "ips",
      "allocate-v6",
      "--private",
      "--network",
      args.network,
      "-a",
      args.app,
      "--json",
    ]);
    if (!result.success) {
      return err(
        `Failed to Allocate Flycast IP: ${result.stderr || result.stdout}`,
      );
    }

    try {
      const ip = FlyIpAllocateSchema.parse(JSON.parse(result.stdout));
      return ok(
        `Allocated Flycast IP ${ip.Address} on network ${args.network}`,
        {
          address: ip.Address,
          type: ip.Type,
          network: args.network,
        },
      );
    } catch {
      // fly ips allocate-v6 may not return JSON; parse text
      return ok(`Allocated Flycast IP on network ${args.network}`, {
        address: result.stdout.trim(),
        type: "private_v6",
        network: args.network,
      });
    }
  }

  async function fly_ip_allocate_v6(args: Args): Promise<CallToolResult> {
    const cmdArgs = ["ips", "allocate-v6", "-a", args.app, "--json"];
    if (args.private) cmdArgs.push("--private");
    if (args.network) cmdArgs.push("--network", args.network);
    if (args.region) cmdArgs.push("--region", args.region);
    if (args.org) cmdArgs.push("--org", args.org);

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Failed to Allocate IPv6: ${result.stderr || result.stdout}`);
    }

    try {
      const ip = FlyIpAllocateSchema.parse(JSON.parse(result.stdout));
      return ok(`Allocated ${ip.Type} ${ip.Address}`, {
        address: ip.Address,
        type: ip.Type,
        region: ip.Region,
        network: ip.Network,
      });
    } catch {
      return ok("Allocated IPv6", {
        address: result.stdout.trim(),
        type: args.private ? "private_v6" : "v6",
        region: undefined,
        network: args.network,
      });
    }
  }

  async function fly_ip_allocate_v4(args: Args): Promise<CallToolResult> {
    const cmdArgs = ["ips", "allocate-v4", "-a", args.app, "--json"];
    if (args.shared) cmdArgs.push("--shared");
    if (args.region) cmdArgs.push("--region", args.region);

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Failed to Allocate IPv4: ${result.stderr || result.stdout}`);
    }

    try {
      const ip = FlyIpAllocateSchema.parse(JSON.parse(result.stdout));
      return ok(`Allocated ${ip.Type} ${ip.Address}`, {
        address: ip.Address,
        type: ip.Type,
        region: ip.Region,
        network: ip.Network,
      });
    } catch {
      return ok("Allocated IPv4", {
        address: result.stdout.trim(),
        type: args.shared ? "shared_v4" : "v4",
        region: undefined,
        network: undefined,
      });
    }
  }

  async function fly_ip_allocate(args: Args): Promise<CallToolResult> {
    const cmdArgs = ["ips", "allocate", "-a", args.app, "--json"];
    if (args.region) cmdArgs.push("--region", args.region);

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Failed to Allocate IPs: ${result.stderr || result.stdout}`);
    }

    // This command may return multiple IPs
    try {
      const parsed = JSON.parse(result.stdout);
      const ips = Array.isArray(parsed) ? parsed : [parsed];
      const normalized = ips.map((ip: { Address?: string; Type?: string }) => ({
        address: ip.Address ?? "",
        type: ip.Type ?? "",
      }));
      return ok(`Allocated ${normalized.length} IP(s)`, { ips: normalized });
    } catch {
      return ok("Allocated IPs", {
        ips: [{ address: result.stdout.trim(), type: "unknown" }],
      });
    }
  }

  // =========================================================================
  // Secrets
  // =========================================================================

  async function fly_secrets_list(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const data = await execJson(
      ["secrets", "list", "-a", args.app, "--json"],
      FlySecretListSchema,
    );
    const secrets = data.map((s) => ({
      name: s.Name,
      digest: s.Digest,
      created_at: s.CreatedAt,
    }));
    return ok(`${secrets.length} secret(s)`, { secrets });
  }

  async function fly_secrets_set(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const pairs = Object.entries(args.secrets as Record<string, string>).map(
      ([k, v]) => `${k}=${v}`,
    );
    const cmdArgs = ["secrets", "set", ...pairs, "-a", args.app];
    if (args.stage) cmdArgs.push("--stage");

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Failed to Set Secrets: ${result.stderr || result.stdout}`);
    }
    return ok(`Set ${pairs.length} secret(s)`, {
      ok: true,
      count: pairs.length,
    });
  }

  async function fly_secrets_unset(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const keys = args.keys as string[];
    const result = await exec(["secrets", "unset", ...keys, "-a", args.app]);
    if (!result.success) {
      return err(`Failed to Unset Secrets: ${result.stderr || result.stdout}`);
    }
    return ok(`Unset ${keys.length} secret(s)`, {
      ok: true,
      count: keys.length,
    });
  }

  // =========================================================================
  // Scale
  // =========================================================================

  async function fly_scale_show(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const data = await execJson(
      ["scale", "show", "-a", args.app, "--json"],
      FlyScaleShowSchema,
    );
    const processes = data.map((p) => ({
      name: p.Process,
      count: p.Count,
      cpu_kind: p.CPUKind,
      cpus: p.CPUs,
      memory_mb: p.Memory,
      regions: p.Regions ?? {},
    }));
    return ok(`${processes.length} process group(s)`, { processes });
  }

  async function fly_scale_count(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const cmdArgs = [
      "scale",
      "count",
      String(args.count),
      "-a",
      args.app,
      "--yes",
    ];
    if (args.region) cmdArgs.push("--region", args.region);
    if (args.process_group) cmdArgs.push("--process-group", args.process_group);

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Failed to Scale: ${result.stderr || result.stdout}`);
    }
    return ok(`Scaled to ${args.count} machine(s)`, { ok: true });
  }

  async function fly_scale_vm(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const cmdArgs = ["scale", "vm", args.size, "-a", args.app, "--yes"];
    if (args.memory) cmdArgs.push("--vm-memory", String(args.memory));

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Failed to Scale VM: ${result.stderr || result.stdout}`);
    }
    return ok(`Scaled VM to ${args.size}`, { ok: true });
  }

  // =========================================================================
  // Volumes
  // =========================================================================

  async function fly_volumes_list(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const data = await execJson(
      ["volumes", "list", "-a", args.app, "--json"],
      FlyVolumeListSchema,
    );
    const volumes = data.map((v) => ({
      id: v.id,
      name: v.name,
      state: v.state,
      size_gb: v.size_gb,
      region: v.region,
      encrypted: v.encrypted,
      attached_machine_id: v.attached_machine_id ?? null,
    }));
    return ok(`${volumes.length} volume(s)`, { volumes });
  }

  async function fly_volumes_create(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const name = args.name ?? "data";
    const cmdArgs = [
      "volumes",
      "create",
      name,
      "-a",
      args.app,
      "--region",
      args.region,
      "--json",
      "--yes",
    ];
    if (args.size_gb) cmdArgs.push("--size", String(args.size_gb));

    const data = await execJson(cmdArgs, FlyVolumeCreateSchema);
    return ok(`Created Volume ${data.id}`, {
      id: data.id,
      name: data.name,
      size_gb: data.size_gb,
      region: data.region,
    });
  }

  async function fly_volumes_destroy(args: Args): Promise<CallToolResult> {
    guard(args.app);
    if (args.confirm !== args.volume_id) {
      return err(
        `Confirmation failed: 'confirm' must exactly match 'volume_id'. ` +
          `Got confirm="${args.confirm}", volume_id="${args.volume_id}".`,
      );
    }
    const result = await exec([
      "volumes",
      "destroy",
      args.volume_id,
      "-a",
      args.app,
      "--yes",
    ]);
    if (!result.success) {
      return err(`Failed to Destroy Volume: ${result.stderr || result.stdout}`);
    }
    return ok(`Destroyed Volume ${args.volume_id}`, {
      ok: true,
      volume_id: args.volume_id,
    });
  }

  // =========================================================================
  // Config
  // =========================================================================

  async function fly_config_show(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const result = await exec(["config", "show", "-a", args.app]);
    if (!result.success) {
      return err(`Failed to Get Config: ${result.stderr || result.stdout}`);
    }
    try {
      const config = JSON.parse(result.stdout);
      return ok(`Config for ${args.app}`, { config });
    } catch {
      return err(`Invalid Config JSON: ${result.stdout.slice(0, 200)}`);
    }
  }

  // =========================================================================
  // Logs
  // =========================================================================

  async function fly_logs(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const cmdArgs = ["logs", "-a", args.app, "--no-tail", "--json"];
    if (args.region) cmdArgs.push("--region", args.region);
    if (args.machine) cmdArgs.push("--machine", args.machine);

    const entries = await execNdjson(cmdArgs, FlyLogEntrySchema);
    const normalized = entries.map((e) => ({
      timestamp: e.timestamp,
      level: e.level ?? "",
      message: e.message,
      region: e.region ?? "",
      instance: e.instance ?? "",
    }));
    return ok(`${normalized.length} Log Entries`, { entries: normalized });
  }

  // =========================================================================
  // Deploy
  // =========================================================================

  async function fly_deploy_safe(args: Args): Promise<CallToolResult> {
    guard(args.app);

    // Mutual exclusivity check
    const modeFlags = [args.image, args.dockerfile, args.template].filter(
      Boolean,
    );
    if (modeFlags.length > 1) {
      return err(
        "Only one of image, dockerfile, or template can be specified.",
      );
    }

    // Resolve template if provided
    let templateResult:
      | { templateDir: string; tempDir: string }
      | undefined;
    if (args.template) {
      const resolved = await resolveTemplate(args.template);
      if ("error" in resolved) return resolved.error;
      templateResult = resolved;
    }

    try {
      const cmdArgs = [
        "deploy",
        "-a",
        args.app,
        "--yes",
        "--no-public-ips",
        "--flycast",
      ];

      if (templateResult) {
        // Template mode: deploy from the template directory
        cmdArgs.splice(1, 0, templateResult.templateDir);
      } else if (args.image) {
        cmdArgs.push("--image", args.image);
      } else if (args.dockerfile) {
        cmdArgs.push("--dockerfile", args.dockerfile);
      }

      if (args.region) cmdArgs.push("--primary-region", args.region);
      if (args.strategy) cmdArgs.push("--strategy", args.strategy);
      if (args.env) {
        for (
          const [k, v] of Object.entries(args.env as Record<string, string>)
        ) {
          cmdArgs.push("-e", `${k}=${v}`);
        }
      }
      if (args.build_args) {
        for (
          const [k, v] of Object.entries(
            args.build_args as Record<string, string>,
          )
        ) {
          cmdArgs.push("--build-arg", `${k}=${v}`);
        }
      }

      const result = await exec(cmdArgs);
      if (!result.success) {
        return err(`Deploy Failed: ${result.stderr || result.stdout}`);
      }

      // Post-flight audit
      const audit = await auditDeploy(args.app);

      if (audit.public_ips_released > 0) {
        return err(
          `Deploy succeeded but ${audit.public_ips_released} public IP(s) were found ` +
            `and released. This should not happen with --no-public-ips. ` +
            `Check fly.toml and deployment config.`,
        );
      }

      return ok(`Deployed ${args.app}`, { ok: true, audit });
    } finally {
      // Clean up template temp directory
      if (templateResult) {
        try {
          Deno.removeSync(templateResult.tempDir, { recursive: true });
        } catch { /* ignore */ }
      }
    }
  }

  async function fly_deploy_unsafe(args: Args): Promise<CallToolResult> {
    // Mutual exclusivity check
    const modeFlags = [args.image, args.dockerfile, args.template].filter(
      Boolean,
    );
    if (modeFlags.length > 1) {
      return err(
        "Only one of image, dockerfile, or template can be specified.",
      );
    }

    // Resolve template if provided
    let templateResult:
      | { templateDir: string; tempDir: string }
      | undefined;
    if (args.template) {
      const resolved = await resolveTemplate(args.template);
      if ("error" in resolved) return resolved.error;
      templateResult = resolved;
    }

    try {
      const cmdArgs = ["deploy", "-a", args.app, "--yes"];

      if (templateResult) {
        cmdArgs.splice(1, 0, templateResult.templateDir);
      } else if (args.image) {
        cmdArgs.push("--image", args.image);
      } else if (args.dockerfile) {
        cmdArgs.push("--dockerfile", args.dockerfile);
      }

      if (args.region) cmdArgs.push("--primary-region", args.region);
      if (args.strategy) cmdArgs.push("--strategy", args.strategy);
      if (args.no_public_ips) cmdArgs.push("--no-public-ips");
      if (args.flycast) cmdArgs.push("--flycast");
      if (args.ha === false) cmdArgs.push("--ha=false");
      if (args.env) {
        for (
          const [k, v] of Object.entries(args.env as Record<string, string>)
        ) {
          cmdArgs.push("-e", `${k}=${v}`);
        }
      }
      if (args.build_args) {
        for (
          const [k, v] of Object.entries(
            args.build_args as Record<string, string>,
          )
        ) {
          cmdArgs.push("--build-arg", `${k}=${v}`);
        }
      }

      const result = await exec(cmdArgs);
      if (!result.success) {
        return err(`Deploy Failed: ${result.stderr || result.stdout}`);
      }
      return ok(`Deployed ${args.app}`, { ok: true });
    } finally {
      if (templateResult) {
        try {
          Deno.removeSync(templateResult.tempDir, { recursive: true });
        } catch { /* ignore */ }
      }
    }
  }

  // =========================================================================
  // Certs (unsafe only)
  // =========================================================================

  async function fly_certs_list(args: Args): Promise<CallToolResult> {
    const data = await execJson(
      ["certs", "list", "-a", args.app, "--json"],
      FlyCertListSchema,
    );
    const certificates = data.map((c) => ({
      hostname: c.Hostname,
      created_at: c.CreatedAt,
    }));
    return ok(`${certificates.length} certificate(s)`, { certificates });
  }

  async function fly_certs_add(args: Args): Promise<CallToolResult> {
    const result = await exec([
      "certs",
      "add",
      args.hostname,
      "-a",
      args.app,
    ]);
    if (!result.success) {
      return err(`Failed to Add Cert: ${result.stderr || result.stdout}`);
    }
    return ok(`Added Certificate for ${args.hostname}`, {
      hostname: args.hostname,
    });
  }

  async function fly_certs_remove(args: Args): Promise<CallToolResult> {
    const result = await exec([
      "certs",
      "remove",
      args.hostname,
      "-a",
      args.app,
      "--yes",
    ]);
    if (!result.success) {
      return err(`Failed to Remove Cert: ${result.stderr || result.stdout}`);
    }
    return ok(`Removed Certificate for ${args.hostname}`, {
      ok: true,
      hostname: args.hostname,
    });
  }

  // =========================================================================
  // Router tools (safe only)
  // =========================================================================

  async function router_list(args: Args): Promise<CallToolResult> {
    const org = args.org ?? getDefaultOrg(await loadConfig());
    const cmdArgs = ["apps", "list", "--json"];
    if (org) cmdArgs.push("--org", org);

    const apps = await execJson(cmdArgs, FlyAppListSchema);
    const routers = apps
      .filter((a) => a.Name.startsWith("ambit-"))
      .map((a) => ({
        network: a.Network ??
          a.Name.replace("ambit-", "").replace(/-[a-z0-9]+$/, ""),
        app_name: a.Name,
        region: undefined,
        machine_state: a.Status,
        private_ip: undefined,
        subnet: undefined,
      }));

    return ok(`${routers.length} router(s)`, { routers });
  }

  async function router_status(args: Args): Promise<CallToolResult> {
    const org = args.org ?? getDefaultOrg(await loadConfig());
    const cmdArgs = ["apps", "list", "--json"];
    if (org) cmdArgs.push("--org", org);

    const apps = await execJson(cmdArgs, FlyAppListSchema);
    const router = apps.find(
      (a) => a.Name.startsWith("ambit-") && (a.Network === args.network),
    );

    if (!router) {
      return err(`No Router Found for Network '${args.network}'`);
    }

    // Get machine details
    let machineInfo: { region?: string; state?: string; private_ip?: string } =
      {};
    try {
      const machines = await execJson(
        ["machines", "list", "-a", router.Name, "--json"],
        FlyMachineListSchema,
      );
      if (machines.length > 0) {
        machineInfo = {
          region: machines[0].region,
          state: machines[0].state,
          private_ip: machines[0].private_ip ?? undefined,
        };
      }
    } catch {
      // best-effort
    }

    const subnet = machineInfo.private_ip
      ? (extractSubnet(machineInfo.private_ip) ?? undefined)
      : undefined;

    // Get tag from Tailscale device (best-effort)
    let tag: string | undefined;
    try {
      const credentials = getCredentialStore();
      const apiKey = await credentials.getTailscaleApiKey();
      if (apiKey) {
        const ts = createTailscaleClient(apiKey);
        const device = await ts.getDeviceByHostname(router.Name);
        tag = device?.tags?.[0];
      }
    } catch {
      // best-effort
    }

    return ok(`Router for Network '${args.network}'`, {
      network: args.network,
      app_name: router.Name,
      region: machineInfo.region,
      machine_state: machineInfo.state ?? router.Status,
      private_ip: machineInfo.private_ip,
      subnet,
      tag,
    });
  }

  async function router_deploy(args: Args): Promise<CallToolResult> {
    try {
      const config = await loadConfig();
      const org = args.org ?? getDefaultOrg(config);
      if (!org) {
        return err(
          "Organization Is Required. Set it in ambit config or pass 'org'.",
        );
      }
      const network = args.network as string;
      const region = (args.region as string) || "iad";
      const selfApprove = args.self_approve ?? false;
      const tag = args.tag || getRouterTag(network);

      // 1. Get Tailscale API key from credential store
      const credentials = getCredentialStore();
      const apiKey = await credentials.getTailscaleApiKey();
      if (!apiKey) {
        return err(
          "Tailscale API Key Not Found. Set TAILSCALE_API_KEY env var or " +
            "run 'ambit create' from the CLI to configure credentials.",
        );
      }

      const ts = createTailscaleClient(apiKey);

      // 2. Validate API key
      if (!(await ts.validateApiKey())) {
        return err("Invalid Tailscale API Key. Check Your API Access Token.");
      }

      // 3. Check tagOwners for the router tag
      if (!(await ts.isTagOwnerConfigured(tag))) {
        return err(
          `Tag ${tag} Is Not Configured in Tailscale ACL tagOwners. ` +
            `Add it before creating a router: ` +
            `"tagOwners": { "${tag}": ["autogroup:admin"] }`,
        );
      }

      // 4. Check autoApprovers (unless self_approve)
      if (!selfApprove && !(await ts.isAutoApproverConfigured(tag))) {
        return err(
          `Tag ${tag} Is Not in autoApprovers. Either configure it in your ` +
            `Tailscale ACL or set self_approve: true to approve routes via API.`,
        );
      }

      // 5. Create Fly app on custom network
      const appName = getRouterAppName(network, randomId(6));
      const createResult = await exec([
        "apps",
        "create",
        appName,
        "--org",
        org,
        "--network",
        network,
        "--json",
      ]);
      if (!createResult.success) {
        return err(
          `Failed to Create App: ${createResult.stderr || createResult.stdout}`,
        );
      }

      // 6. Set secrets (staged — applied on deploy)
      const secretResult = await exec([
        "secrets",
        "set",
        `TAILSCALE_API_TOKEN=${apiKey}`,
        `NETWORK_NAME=${network}`,
        `TAILSCALE_TAGS=${tag}`,
        "-a",
        appName,
        "--stage",
      ]);
      if (!secretResult.success) {
        return err(
          `Failed to Set Secrets: ${
            secretResult.stderr || secretResult.stdout
          }`,
        );
      }

      // 7. Deploy router container
      const dockerDir = getRouterDockerDir();
      const deployResult = await exec([
        "deploy",
        dockerDir,
        "-a",
        appName,
        "--yes",
        "--ha=false",
        "--primary-region",
        region,
      ]);
      if (!deployResult.success) {
        return err(
          `Router Deploy Failed: ${deployResult.stderr || deployResult.stdout}`,
        );
      }

      // 8. Wait for device to join tailnet
      const device = await waitForDevice(ts, appName, 180000);

      // 9. Get subnet from machine's private IP
      let subnet: string | undefined;
      try {
        const machines = await execJson(
          ["machines", "list", "-a", appName, "--json"],
          FlyMachineListSchema,
        );
        const routerMachine = machines.find((m) => m.private_ip);
        if (routerMachine?.private_ip) {
          subnet = extractSubnet(routerMachine.private_ip);
        }
      } catch {
        // best-effort — subnet is optional in the output
      }

      // 10. If self_approve, approve routes via API
      if (selfApprove && subnet) {
        await ts.approveSubnetRoutes(device.id, [subnet]);
      }

      // 11. Configure split DNS
      await ts.setSplitDns(network, [device.addresses[0]]);

      return ok(`Deployed Router for Network '${network}'`, {
        network,
        app_name: appName,
        tag,
        subnet,
      });
    } catch (e) {
      return err(
        `Router Deploy Failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function router_destroy(args: Args): Promise<CallToolResult> {
    try {
      const config = await loadConfig();
      const org = args.org ?? getDefaultOrg(config);
      const network = args.network as string;

      // 1. Get Tailscale API key
      const credentials = getCredentialStore();
      const apiKey = await credentials.getTailscaleApiKey();
      if (!apiKey) {
        return err(
          "Tailscale API Key Not Found. Set TAILSCALE_API_KEY env var or " +
            "run 'ambit create' from the CLI to configure credentials.",
        );
      }

      const ts = createTailscaleClient(apiKey);

      // 2. Find the router app for this network
      const listArgs = ["apps", "list", "--json"];
      if (org) listArgs.push("--org", org);
      const apps = await execJson(listArgs, FlyAppListSchema);
      const router = apps.find(
        (a) => a.Name.startsWith("ambit-") && a.Network === network,
      );

      if (!router) {
        return err(`No Router Found for Network '${network}'`);
      }

      // 3. Clear split DNS
      try {
        await ts.clearSplitDns(network);
      } catch {
        // Already cleared or not configured
      }

      // 4. Remove Tailscale device
      try {
        const device = await ts.getDeviceByHostname(router.Name);
        if (device) {
          await ts.deleteDevice(device.id);
        }
      } catch {
        // Device may already be gone
      }

      // 5. Destroy Fly app
      const destroyResult = await exec([
        "apps",
        "destroy",
        router.Name,
        "--yes",
      ]);
      if (!destroyResult.success) {
        return err(
          `Failed to Destroy App: ${
            destroyResult.stderr || destroyResult.stdout
          }`,
        );
      }

      return ok(`Destroyed Router for Network '${network}'`, {
        ok: true,
        network,
      });
    } catch (e) {
      return err(
        `Router Destroy Failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function router_doctor(args: Args): Promise<CallToolResult> {
    try {
      const checks: { name: string; passed: boolean; hint?: string }[] = [];
      const check = (name: string, passed: boolean, hint?: string) => {
        checks.push(hint ? { name, passed, hint } : { name, passed });
      };

      // 1. Check Tailscale CLI installed
      check(
        "Tailscale Installed",
        await isTailscaleInstalled(),
        "Install from https://tailscale.com/download",
      );

      // 2. Check Tailscale connected
      const tsStatus = await runCommand(["tailscale", "status", "--json"]);
      let tsConnected = false;
      if (tsStatus.success) {
        try {
          const parsed = JSON.parse(tsStatus.stdout);
          tsConnected = parsed.BackendState === "Running";
        } catch { /* ignore parse error */ }
      }
      check("Tailscale Connected", tsConnected, "Run: tailscale up");

      // 3. Check accept-routes enabled
      check(
        "Accept Routes Enabled",
        await isAcceptRoutesEnabled(),
        "Run: sudo tailscale set --accept-routes",
      );

      // 4. Check credentials available
      const credentials = getCredentialStore();
      const apiKey = await credentials.getTailscaleApiKey();
      check(
        "Tailscale API Key Available",
        !!apiKey,
        "Set TAILSCALE_API_KEY env var or run 'ambit create' to configure",
      );

      // 5. Router checks (only if we have credentials)
      if (apiKey) {
        const ts = createTailscaleClient(apiKey);
        const config = await loadConfig();
        const org = args.org ?? getDefaultOrg(config);

        if (args.network) {
          // Check specific network
          const listArgs = ["apps", "list", "--json"];
          if (org) listArgs.push("--org", org);
          const apps = await execJson(listArgs, FlyAppListSchema);
          const router = apps.find(
            (a) => a.Name.startsWith("ambit-") && a.Network === args.network,
          );

          check(
            `Router Exists (${args.network})`,
            !!router,
            `Create with: ambit create ${args.network}`,
          );

          if (router) {
            // Check machine running
            try {
              const machines = await execJson(
                ["machines", "list", "-a", router.Name, "--json"],
                FlyMachineListSchema,
              );
              const machine = machines[0];
              check(
                `Router Running (${args.network})`,
                machine?.state === "started",
                machine
                  ? `Machine state: ${machine.state}`
                  : "No machine found",
              );
            } catch {
              check(
                `Router Running (${args.network})`,
                false,
                "Could not check machine status",
              );
            }

            // Check in tailnet
            try {
              const device = await ts.getDeviceByHostname(router.Name);
              check(
                `Router in Tailnet (${args.network})`,
                device !== null,
                "Router may still be starting, or check router logs",
              );
            } catch {
              check(
                `Router in Tailnet (${args.network})`,
                false,
                "Could not check tailnet status",
              );
            }
          }
        } else {
          // Check all networks
          const listArgs = ["apps", "list", "--json"];
          if (org) listArgs.push("--org", org);
          const apps = await execJson(listArgs, FlyAppListSchema);
          const routerApps = apps.filter((a) => a.Name.startsWith("ambit-"));

          if (routerApps.length === 0) {
            check(
              "Routers Discovered",
              false,
              "Run: ambit create <network>",
            );
          } else {
            let runningCount = 0;
            let inTailnetCount = 0;

            for (const app of routerApps) {
              try {
                const machines = await execJson(
                  ["machines", "list", "-a", app.Name, "--json"],
                  FlyMachineListSchema,
                );
                if (machines[0]?.state === "started") runningCount++;
              } catch { /* skip */ }

              try {
                const device = await ts.getDeviceByHostname(app.Name);
                if (device) inTailnetCount++;
              } catch { /* skip */ }
            }

            check(
              "Routers Discovered",
              runningCount > 0,
              `${routerApps.length} Router(s): ${runningCount} Running, ` +
                `${inTailnetCount} in Tailnet`,
            );
          }
        }
      }

      const healthy = checks.every((c) => c.passed);
      const issues = checks.filter((c) => !c.passed).length;
      return ok(
        healthy
          ? "All Checks Passed"
          : `${issues} Issue${issues > 1 ? "s" : ""} Found`,
        { checks, healthy },
      );
    } catch (e) {
      return err(
        `Router Doctor Failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function router_logs(args: Args): Promise<CallToolResult> {
    const org = args.org ?? getDefaultOrg(await loadConfig());
    const cmdArgs = ["apps", "list", "--json"];
    if (org) cmdArgs.push("--org", org);

    const apps = await execJson(cmdArgs, FlyAppListSchema);
    const router = apps.find(
      (a) => a.Name.startsWith("ambit-") && (a.Network === args.network),
    );

    if (!router) {
      return err(`No Router Found for Network '${args.network}'`);
    }

    const logArgs = ["logs", "-a", router.Name, "--no-tail", "--json"];
    const entries = await execNdjson(logArgs, FlyLogEntrySchema);
    const normalized = entries.map((e) => ({
      timestamp: e.timestamp,
      level: e.level ?? "",
      message: e.message,
      region: e.region ?? "",
      instance: e.instance ?? "",
    }));
    return ok(`${normalized.length} Router Log Entries`, {
      entries: normalized,
    });
  }

  // =========================================================================
  // Assemble handler map
  // =========================================================================

  const handlers: Record<string, Handler> = {
    // Common
    fly_auth_status,
    fly_app_status,
    fly_app_list,
    fly_app_create,
    fly_app_destroy,
    fly_machine_list,
    fly_machine_start,
    fly_machine_stop,
    fly_machine_destroy,
    fly_machine_exec,
    fly_ip_list,
    fly_ip_release,
    fly_secrets_list,
    fly_secrets_set,
    fly_secrets_unset,
    fly_scale_show,
    fly_scale_count,
    fly_scale_vm,
    fly_volumes_list,
    fly_volumes_create,
    fly_volumes_destroy,
    fly_config_show,
    fly_logs,
    // Deploy (mode-specific)
    fly_deploy: safe ? fly_deploy_safe : fly_deploy_unsafe,
  };

  if (safe) {
    // Safe-only tools
    handlers.fly_ip_allocate_flycast = fly_ip_allocate_flycast;
    handlers.router_list = router_list;
    handlers.router_status = router_status;
    handlers.router_deploy = router_deploy;
    handlers.router_destroy = router_destroy;
    handlers.router_doctor = router_doctor;
    handlers.router_logs = router_logs;
  } else {
    // Unsafe-only tools
    handlers.fly_ip_allocate_v6 = fly_ip_allocate_v6;
    handlers.fly_ip_allocate_v4 = fly_ip_allocate_v4;
    handlers.fly_ip_allocate = fly_ip_allocate;
    handlers.fly_certs_list = fly_certs_list;
    handlers.fly_certs_add = fly_certs_add;
    handlers.fly_certs_remove = fly_certs_remove;
  }

  return handlers;
}
