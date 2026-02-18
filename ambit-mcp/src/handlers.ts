// =============================================================================
// ambit-mcp: Tool Handlers
// =============================================================================
// Each handler: parse args → build flyctl command → exec → normalize → return
// structuredContent. Safe-mode handlers call guards; unsafe-mode handlers don't.
// =============================================================================

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Mode } from "./tools.ts";
import { exec, execJson, execNdjson } from "./exec.ts";
import { loadConfig, getDefaultNetwork, getDefaultOrg } from "./config.ts";
import { assertNotRouter, auditDeploy } from "./guard.ts";
import {
  FlyAuthSchema,
  FlyAppListSchema,
  FlyAppStatusSchema,
  FlyMachineListSchema,
  FlyIpListSchema,
  FlyIpAllocateSchema,
  FlySecretListSchema,
  FlyVolumeListSchema,
  FlyVolumeCreateSchema,
  FlyScaleShowSchema,
  FlyLogEntrySchema,
  FlyCertListSchema,
} from "./schemas.ts";

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
      return ok("Not authenticated. Run 'fly auth login' in your terminal.", {
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
      return err(`Failed to create app: ${result.stderr || result.stdout}`);
    }

    return ok(`Created app ${args.name}`, {
      name: args.name,
      network: network ?? null,
      org: org ?? "",
    });
  }

  async function fly_app_destroy(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const result = await exec(["apps", "destroy", args.app, "--yes"]);
    if (!result.success) {
      return err(`Failed to destroy app: ${result.stderr || result.stdout}`);
    }
    return ok(`Destroyed app ${args.app}`, { ok: true, app: args.app });
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
      cpu_kind: m.config?.guest?.cpu_kind ?? null,
      cpus: m.config?.guest?.cpus ?? null,
      memory_mb: m.config?.guest?.memory_mb ?? null,
    }));
    return ok(`${machines.length} machine(s)`, { machines });
  }

  async function fly_machine_start(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const result = await exec([
      "machines", "start", args.machine_id, "-a", args.app,
    ]);
    if (!result.success) {
      return err(`Failed to start machine: ${result.stderr || result.stdout}`);
    }
    return ok(`Started machine ${args.machine_id}`, {
      ok: true,
      machine_id: args.machine_id,
    });
  }

  async function fly_machine_stop(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const result = await exec([
      "machines", "stop", args.machine_id, "-a", args.app,
    ]);
    if (!result.success) {
      return err(`Failed to stop machine: ${result.stderr || result.stdout}`);
    }
    return ok(`Stopped machine ${args.machine_id}`, {
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
      return err(`Failed to destroy machine: ${result.stderr || result.stdout}`);
    }
    return ok(`Destroyed machine ${args.machine_id}`, {
      ok: true,
      machine_id: args.machine_id,
    });
  }

  async function fly_machine_exec(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const cmdArgs = [
      "machine", "exec", args.machine_id,
      ...args.command,
      "-a", args.app,
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
      "ips", "release", args.address, "-a", args.app, "--yes",
    ]);
    if (!result.success) {
      return err(`Failed to release IP: ${result.stderr || result.stdout}`);
    }
    return ok(`Released ${args.address}`, { ok: true, address: args.address });
  }

  async function fly_ip_allocate_flycast(args: Args): Promise<CallToolResult> {
    guard(args.app);
    // Safe mode: always --private --network <name>
    const result = await exec([
      "ips", "allocate-v6", "--private",
      "--network", args.network,
      "-a", args.app,
      "--json",
    ]);
    if (!result.success) {
      return err(`Failed to allocate Flycast IP: ${result.stderr || result.stdout}`);
    }

    try {
      const ip = FlyIpAllocateSchema.parse(JSON.parse(result.stdout));
      return ok(`Allocated Flycast IP ${ip.Address} on network ${args.network}`, {
        address: ip.Address,
        type: ip.Type,
        network: args.network,
      });
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
      return err(`Failed to allocate IPv6: ${result.stderr || result.stdout}`);
    }

    try {
      const ip = FlyIpAllocateSchema.parse(JSON.parse(result.stdout));
      return ok(`Allocated ${ip.Type} ${ip.Address}`, {
        address: ip.Address,
        type: ip.Type,
        region: ip.Region ?? null,
        network: ip.Network ?? null,
      });
    } catch {
      return ok("Allocated IPv6", {
        address: result.stdout.trim(),
        type: args.private ? "private_v6" : "v6",
        region: null,
        network: args.network ?? null,
      });
    }
  }

  async function fly_ip_allocate_v4(args: Args): Promise<CallToolResult> {
    const cmdArgs = ["ips", "allocate-v4", "-a", args.app, "--json"];
    if (args.shared) cmdArgs.push("--shared");
    if (args.region) cmdArgs.push("--region", args.region);

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Failed to allocate IPv4: ${result.stderr || result.stdout}`);
    }

    try {
      const ip = FlyIpAllocateSchema.parse(JSON.parse(result.stdout));
      return ok(`Allocated ${ip.Type} ${ip.Address}`, {
        address: ip.Address,
        type: ip.Type,
        region: ip.Region ?? null,
        network: ip.Network ?? null,
      });
    } catch {
      return ok("Allocated IPv4", {
        address: result.stdout.trim(),
        type: args.shared ? "shared_v4" : "v4",
        region: null,
        network: null,
      });
    }
  }

  async function fly_ip_allocate(args: Args): Promise<CallToolResult> {
    const cmdArgs = ["ips", "allocate", "-a", args.app, "--json"];
    if (args.region) cmdArgs.push("--region", args.region);

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Failed to allocate IPs: ${result.stderr || result.stdout}`);
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
      return err(`Failed to set secrets: ${result.stderr || result.stdout}`);
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
      return err(`Failed to unset secrets: ${result.stderr || result.stdout}`);
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
      "scale", "count", String(args.count), "-a", args.app, "--yes",
    ];
    if (args.region) cmdArgs.push("--region", args.region);
    if (args.process_group) cmdArgs.push("--process-group", args.process_group);

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Failed to scale: ${result.stderr || result.stdout}`);
    }
    return ok(`Scaled to ${args.count} machine(s)`, { ok: true });
  }

  async function fly_scale_vm(args: Args): Promise<CallToolResult> {
    guard(args.app);
    const cmdArgs = ["scale", "vm", args.size, "-a", args.app, "--yes"];
    if (args.memory) cmdArgs.push("--vm-memory", String(args.memory));

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Failed to scale VM: ${result.stderr || result.stdout}`);
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
      "volumes", "create", name,
      "-a", args.app,
      "--region", args.region,
      "--json", "--yes",
    ];
    if (args.size_gb) cmdArgs.push("--size", String(args.size_gb));

    const data = await execJson(cmdArgs, FlyVolumeCreateSchema);
    return ok(`Created volume ${data.id}`, {
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
      "volumes", "destroy", args.volume_id, "-a", args.app, "--yes",
    ]);
    if (!result.success) {
      return err(`Failed to destroy volume: ${result.stderr || result.stdout}`);
    }
    return ok(`Destroyed volume ${args.volume_id}`, {
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
      return err(`Failed to get config: ${result.stderr || result.stdout}`);
    }
    try {
      const config = JSON.parse(result.stdout);
      return ok(`Config for ${args.app}`, { config });
    } catch {
      return err(`Invalid config JSON: ${result.stdout.slice(0, 200)}`);
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
    return ok(`${normalized.length} log entries`, { entries: normalized });
  }

  // =========================================================================
  // Deploy
  // =========================================================================

  async function fly_deploy_safe(args: Args): Promise<CallToolResult> {
    guard(args.app);

    const cmdArgs = [
      "deploy", "-a", args.app,
      "--yes", "--no-public-ips", "--flycast",
    ];
    if (args.image) cmdArgs.push("--image", args.image);
    if (args.dockerfile) cmdArgs.push("--dockerfile", args.dockerfile);
    if (args.region) cmdArgs.push("--primary-region", args.region);
    if (args.strategy) cmdArgs.push("--strategy", args.strategy);
    if (args.env) {
      for (const [k, v] of Object.entries(args.env as Record<string, string>)) {
        cmdArgs.push("-e", `${k}=${v}`);
      }
    }
    if (args.build_args) {
      for (const [k, v] of Object.entries(args.build_args as Record<string, string>)) {
        cmdArgs.push("--build-arg", `${k}=${v}`);
      }
    }

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Deploy failed: ${result.stderr || result.stdout}`);
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
  }

  async function fly_deploy_unsafe(args: Args): Promise<CallToolResult> {
    const cmdArgs = ["deploy", "-a", args.app, "--yes"];
    if (args.image) cmdArgs.push("--image", args.image);
    if (args.dockerfile) cmdArgs.push("--dockerfile", args.dockerfile);
    if (args.region) cmdArgs.push("--primary-region", args.region);
    if (args.strategy) cmdArgs.push("--strategy", args.strategy);
    if (args.no_public_ips) cmdArgs.push("--no-public-ips");
    if (args.flycast) cmdArgs.push("--flycast");
    if (args.ha === false) cmdArgs.push("--ha=false");
    if (args.env) {
      for (const [k, v] of Object.entries(args.env as Record<string, string>)) {
        cmdArgs.push("-e", `${k}=${v}`);
      }
    }
    if (args.build_args) {
      for (const [k, v] of Object.entries(args.build_args as Record<string, string>)) {
        cmdArgs.push("--build-arg", `${k}=${v}`);
      }
    }

    const result = await exec(cmdArgs);
    if (!result.success) {
      return err(`Deploy failed: ${result.stderr || result.stdout}`);
    }
    return ok(`Deployed ${args.app}`, { ok: true });
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
      created_at: c.CreatedAt ?? null,
    }));
    return ok(`${certificates.length} certificate(s)`, { certificates });
  }

  async function fly_certs_add(args: Args): Promise<CallToolResult> {
    const result = await exec([
      "certs", "add", args.hostname, "-a", args.app,
    ]);
    if (!result.success) {
      return err(`Failed to add cert: ${result.stderr || result.stdout}`);
    }
    return ok(`Added certificate for ${args.hostname}`, {
      hostname: args.hostname,
    });
  }

  async function fly_certs_remove(args: Args): Promise<CallToolResult> {
    const result = await exec([
      "certs", "remove", args.hostname, "-a", args.app, "--yes",
    ]);
    if (!result.success) {
      return err(`Failed to remove cert: ${result.stderr || result.stdout}`);
    }
    return ok(`Removed certificate for ${args.hostname}`, {
      ok: true,
      hostname: args.hostname,
    });
  }

  // =========================================================================
  // Router tools (safe only)
  // =========================================================================
  // These are stubs — router management is complex and will be implemented
  // against the ambit CLI library in a future iteration.
  // =========================================================================

  async function router_list(args: Args): Promise<CallToolResult> {
    const org = args.org ?? getDefaultOrg(await loadConfig());
    const cmdArgs = ["apps", "list", "--json"];
    if (org) cmdArgs.push("--org", org);

    const apps = await execJson(cmdArgs, FlyAppListSchema);
    const routers = apps
      .filter((a) => a.Name.startsWith("ambit-"))
      .map((a) => ({
        network: a.Network ?? a.Name.replace("ambit-", "").replace(/-[a-z0-9]+$/, ""),
        app_name: a.Name,
        region: null,
        machine_state: a.Status,
        private_ip: null,
        subnet: null,
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
      return err(`No router found for network '${args.network}'`);
    }

    // Get machine details
    let machineInfo: { region?: string; state?: string; private_ip?: string } = {};
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

    return ok(`Router for network '${args.network}'`, {
      network: args.network,
      app_name: router.Name,
      region: machineInfo.region ?? null,
      machine_state: machineInfo.state ?? router.Status,
      private_ip: machineInfo.private_ip ?? null,
      subnet: null,
      tag: null,
    });
  }

  function router_deploy(_args: Args): Promise<CallToolResult> {
    // Router deployment is complex (create app, set secrets, deploy container,
    // wait for tailnet join, configure DNS). Deferred to ambit CLI integration.
    return Promise.resolve(
      err(
        "Router deployment is not yet implemented in the MCP server. " +
        "Use 'ambit create' from the CLI.",
      ),
    );
  }

  function router_destroy(_args: Args): Promise<CallToolResult> {
    return Promise.resolve(
      err(
        "Router destruction is not yet implemented in the MCP server. " +
        "Use 'ambit destroy' from the CLI.",
      ),
    );
  }

  function router_doctor(_args: Args): Promise<CallToolResult> {
    return Promise.resolve(
      err(
        "Router doctor is not yet implemented in the MCP server. " +
        "Use 'ambit doctor' from the CLI.",
      ),
    );
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
      return err(`No router found for network '${args.network}'`);
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
    return ok(`${normalized.length} router log entries`, { entries: normalized });
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
