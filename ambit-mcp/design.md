# ambit-mcp: Design Document

## Overview

An MCP server that exposes safe Fly.io deployment operations to LLM agents.
The server wraps `flyctl` CLI commands under four hard rules:

1. **Explicit network targeting** — Flycast IPs always specify `--network <name>`
   so we know exactly which private network can reach the app
2. **Nothing public** — no public IPs, no public services, no public ports, ever
3. **Flycast-only exposure** — services are only reachable through Flycast
   private addresses on an explicit custom 6PN
4. **Deploy-time config auditing** — every deploy is scanned pre-flight and
   audited post-flight for anything that implies public exposure

The target use case: managing workload apps (browser instances, services, etc.)
that live on a custom private network alongside a ambit Tailscale subnet
router — reachable as `<app>.<network>` from a tailnet, never from the internet.

---

## Context: What ambit Does

ambit deploys a Tailscale subnet router onto a Fly.io custom 6PN.
The router:

1. Joins a custom network via `fly apps create --network <name>`
2. Advertises the network's `/48` subnet to a Tailscale tailnet
3. Runs a DNS proxy that rewrites `<app>.<network>` → `<app>.flycast`
4. Any Flycast app on the same custom network becomes reachable from the tailnet

The MCP server manages **the workload apps** that live behind this router.
It does NOT manage the router itself (that's `ambit create/destroy/status/doctor`).

---

## The Four Rules

### Rule 1: Explicit Network Targeting

Flycast works by allocating a private IPv6 that is reachable **from a specific
custom 6PN**. The `--network` flag names the originating network:

```
fly ips allocate-v6 --private --network browsers -a my-app
```

This makes `my-app` reachable as `my-app.flycast` from machines on the
`browsers` network, but NOT from the default org network or other custom 6PNs.

The MCP server **always** requires the network name — it is never inferred or
omitted. The configured ambit network is the default, but it is always
passed explicitly to the CLI. This makes the access boundary auditable: you can
always answer "who can reach this app?" by inspecting its Flycast allocations.

### Rule 2: Nothing Public

The following are **structurally impossible** through this MCP server:

- `fly ips allocate-v4` — never invoked, no tool exposes it
- `fly ips allocate-v6` without `--private` — never invoked
- `fly ips allocate` (recommended IPs) — never invoked
- `fly machine create/run/update --port` — no tool passes port flags
- `fly certs add` — no tool exposes certificate management
- `fly deploy` without `--no-public-ips` — enforced by the executor

There is no "run arbitrary fly command" tool. The CLI executor only runs
commands it constructs itself from validated, typed inputs.

### Rule 3: Flycast-Only Exposure

Apps on a custom 6PN can communicate in two ways:

- **Direct 6PN** (`<app>.internal`) — Machine-to-Machine, no proxy, no autostart
- **Flycast** (`<app>.flycast`) — through Fly Proxy, with autostart/autostop,
  geographic load balancing, and stable DNS

This server ensures apps are only exposed via Flycast:

- `fly deploy` always passes `--flycast` (allocates private IPv6 if missing)
- `fly_ip_allocate_flycast` always passes `--private --network <name>`
- After every deploy, the IP list is audited — any non-`private_v6` IPs are
  released and the operation is flagged as an error

### Rule 4: Deploy-Time Config Auditing

The deploy tool runs a two-phase safety check:

**Pre-flight (before `fly deploy` runs):**
- If a `fly.toml` path is provided, parse it and reject if it contains:
  - `[[services]]` with `ports` that have `handlers` including `tls`
    combined with no `force_https = false` — implies public TLS termination
  - `[http_service]` with `force_https = true` — implies public HTTPS
  - `[http_service]` with `auto_start_machines = false` + no Flycast — dead config
  - Any `[[services]]` binding — warn that Flycast handles service routing;
    services blocks in fly.toml define internal port/protocol for Fly Proxy,
    which is fine, but combined with public IPs they become dangerous
- If `--image` is used (no local fly.toml), skip pre-flight — rely on post-flight

**Post-flight (after `fly deploy` completes):**
1. `fly ips list -a <app> --json` — enumerate all allocated IPs
2. Classify each IP: `private_v6` (Flycast) is safe; everything else is unsafe
3. For each unsafe IP: `fly ips release <addr> -a <app>` — remove it immediately
4. `fly config show -a <app>` — fetch the merged platform config
5. Check for services that would be publicly routable if a public IP were re-added
6. Return audit results to the caller:
   - `public_ips_found`: number removed (0 = clean)
   - `flycast_ips`: list of Flycast allocations with their target networks
   - `warnings`: any config concerns (e.g. services block present)

If any public IPs were found and removed, the tool returns an error (not success)
with a message explaining what happened and what to fix.

---

## Threat Model

| Threat | Rule | Mitigation |
|---|---|---|
| LLM allocates public IPv4/v6 | 2 | Command never constructed; no tool exposes it |
| LLM deploys without `--no-public-ips` | 2 | Executor always injects the flag |
| LLM exposes ports via `--port` on machine ops | 2 | No tool passes port flags; executor rejects `-p`/`--port` |
| fly.toml has `[[services]]` that bind public | 4 | Pre-flight rejects; post-flight releases any allocated public IPs |
| Flycast allocated without `--network` (reachable from default network) | 1 | `--network` is always required and always passed |
| LLM creates app on default network | 1 | `--network` is always passed on `fly apps create` |
| LLM targets the router app | — | `ambit-*` prefix guard on every tool |
| flyctl not authenticated | — | Auth gate on startup; clear error message |
| Orphaned public IPs from prior manual ops | 3,4 | `fly_ip_list` for auditing; `fly_ip_release` for cleanup |

---

## Fly CLI Auth State Machine

```
                   ┌──────────────┐
                   │  No Token    │
                   │  (Logged Out)│
                   └──────┬───────┘
                          │
                   fly auth login
                          │
                          ▼
                   ┌──────────────┐
                   │ Authenticated│◄──── fly auth whoami --json
                   │  (Token OK)  │      returns { email: "..." }
                   └──────┬───────┘
                          │
                   fly auth logout
                          │
                          ▼
                   ┌──────────────┐
                   │  No Token    │
                   │  (Logged Out)│
                   └──────────────┘
```

The MCP server treats auth as a **precondition gate**:
- On startup / first tool call: run `fly auth whoami --json`
- If it fails: return a clear error — the server cannot invoke `fly auth login`
- If it succeeds: cache the email, proceed

Token source: `FLY_API_TOKEN` env var > `~/.fly/config.yml` (from `fly auth login`).

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  MCP Client (Claude, Cursor, etc.)                       │
└────────────────────────┬─────────────────────────────────┘
                         │ stdio (JSON-RPC)
                         ▼
┌──────────────────────────────────────────────────────────┐
│  ambit-mcp (McpServer)                               │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │   Tools     │  │  Resources  │  │  Safety Layer   │  │
│  │  (actions)  │  │  (reads)    │  │  (4 rules)      │  │
│  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  │
│         │                │                   │           │
│         ▼                ▼                   ▼           │
│  ┌───────────────────────────────────────────────────┐   │
│  │  fly CLI executor                                 │   │
│  │  - arg builder (injects enforced flags)           │   │
│  │  - Zod parser (validates all JSON output)         │   │
│  │  - blocklist (rejects dangerous flags)            │   │
│  │  - auditor (pre-flight + post-flight checks)      │   │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
                         │
                         ▼
                   flyctl binary
```

### Key Design Decisions

1. **Stdio transport only** — runs locally alongside flyctl

2. **All outputs through Zod** — every `--json` response is parsed and
   validated. Unknown shapes fail loudly.

3. **Network-scoped** — reads `~/.config/ambit/config.json` on startup.
   All operations scope to the configured network and org.

4. **Constructed commands only** — no "pass-through" or "raw command" tool.
   The executor only runs commands it builds from typed inputs.

5. **Two-phase deploy audit** — pre-flight scans fly.toml for danger signals,
   post-flight verifies the actual platform state and cleans up violations.

---

## Tools (MCP Actions)

### Read-Only / Observability

#### `fly_auth_status`
Check if flyctl is authenticated.
```
Inputs:  (none)
Outputs: { authenticated: bool, email?: string }
Command: fly auth whoami --json
```

#### `fly_app_status`
Status of a specific app.
```
Inputs:  { app: string }
Outputs: { id, name, deployed, hostname, machines: [...] }
Command: fly status -a <app> --json
Guard:   assertNotRouter(app)
```

#### `fly_app_list`
List apps in the configured org.
```
Inputs:  { org?: string }
Outputs: FlyApp[] (excluding ambit-* prefix)
Command: fly apps list --org <org> --json
Filter:  exclude apps with prefix "ambit-"
```

#### `fly_machine_list`
List machines for an app.
```
Inputs:  { app: string }
Outputs: FlyMachine[]
Command: fly machines list -a <app> --json
Guard:   assertNotRouter(app)
```

#### `fly_ip_list`
List IP allocations for an app. Essential for auditing exposure.
```
Inputs:  { app: string }
Outputs: FlyIp[] (each with Type, Address, Region, Network)
Command: fly ips list -a <app> --json
Guard:   assertNotRouter(app)
```

#### `fly_logs`
Fetch recent logs.
```
Inputs:  { app: string, region?: string, machine?: string }
Outputs: structured JSON log lines
Command: fly logs -a <app> --no-tail --json [--region <r>] [--machine <m>]
Guard:   assertNotRouter(app)
```

#### `fly_scale_show`
Show current VM size and count.
```
Inputs:  { app: string }
Outputs: ScaleInfo
Command: fly scale show -a <app> --json
Guard:   assertNotRouter(app)
```

#### `fly_secrets_list`
List secret names (never values).
```
Inputs:  { app: string }
Outputs: SecretInfo[] (name, digest, createdAt)
Command: fly secrets list -a <app> --json
Guard:   assertNotRouter(app)
```

#### `fly_volumes_list`
List volumes for an app.
```
Inputs:  { app: string }
Outputs: Volume[]
Command: fly volumes list -a <app> --json
Guard:   assertNotRouter(app)
```

#### `fly_config_show`
Show merged platform config (the live fly.toml + platform state).
```
Inputs:  { app: string }
Outputs: object (JSON config)
Command: fly config show -a <app>
Guard:   assertNotRouter(app)
```

### Mutations

#### `fly_app_create`
Create a new app on the configured custom network.
```
Inputs:  { name: string, org?: string, network?: string }
Outputs: { name, network, org }
Command: fly apps create <name> --network <network> --org <org> --json
Enforce: --network ALWAYS passed (defaults to config.network)    [Rule 1]
Audit:   fly ips list — must be empty after creation              [Rule 4]
```

#### `fly_app_destroy`
Destroy an app.
```
Inputs:  { app: string, confirm: string }
Outputs: { success: bool }
Command: fly apps destroy <app> --yes
Guard:   assertNotRouter(app)
Guard:   confirm must exactly equal app name
```

#### `fly_deploy`
Deploy an app. The most heavily guarded mutation.
```
Inputs:  { app: string, image?: string, dockerfile?: string,
           region?: string, strategy?: "canary"|"rolling"|"bluegreen"|"immediate",
           env?: Record<string, string>,
           build_args?: Record<string, string> }
Outputs: { success: bool, audit: DeployAuditResult }
Guard:   assertNotRouter(app)
Enforce: --no-public-ips ALWAYS passed                            [Rule 2]
Enforce: --flycast ALWAYS passed                                  [Rule 3]
Pre:     scan fly.toml if available (see Rule 4 details below)    [Rule 4]
Post:    full audit (see Rule 4 details below)                    [Rule 4]
Command: fly deploy -a <app> --yes --no-public-ips --flycast
           [--image <img>] [--dockerfile <path>]
           [--strategy <s>] [--primary-region <r>]
           [-e KEY=VAL ...] [--build-arg K=V ...]
```

**Pre-flight checks** (when fly.toml / Dockerfile path available):
1. Parse fly.toml (TOML → object)
2. Reject if `[http_service].force_https = true` — implies public HTTPS
3. Reject if any `[[services]]` port has `handlers` containing `"tls"` +
   `"http"` on port 443 — this is the standard public HTTPS pattern
4. Warn if `[[services]]` block is present — it's fine for Flycast internal
   routing, but flag it so the caller is aware

**Post-flight audit:**
1. `fly ips list -a <app> --json`
2. Any IP where `Type != "private_v6"` → release immediately via `fly ips release`
3. `fly config show -a <app>` → inspect merged config for services exposure
4. Return `DeployAuditResult`:
   ```typescript
   interface DeployAuditResult {
     public_ips_released: number;     // 0 = clean
     flycast_allocations: Array<{
       address: string;
       network: string;              // which 6PN can reach this
     }>;
     config_warnings: string[];       // anything suspicious
   }
   ```
5. If `public_ips_released > 0`: return error, not success

#### `fly_secrets_set`
Set encrypted secrets.
```
Inputs:  { app: string, secrets: Record<string, string>, stage?: bool }
Outputs: { success: bool, count: number }
Command: fly secrets set K1=V1 K2=V2 -a <app> [--stage]
Guard:   assertNotRouter(app)
```

#### `fly_secrets_unset`
Remove secrets.
```
Inputs:  { app: string, keys: string[] }
Outputs: { success: bool }
Command: fly secrets unset K1 K2 -a <app>
Guard:   assertNotRouter(app)
```

#### `fly_machine_stop`
Stop a running machine.
```
Inputs:  { app: string, machine_id: string }
Outputs: { success: bool }
Command: fly machines stop <machine_id> -a <app>
Guard:   assertNotRouter(app)
```

#### `fly_machine_start`
Start a stopped machine.
```
Inputs:  { app: string, machine_id: string }
Outputs: { success: bool }
Command: fly machines start <machine_id> -a <app>
Guard:   assertNotRouter(app)
```

#### `fly_machine_destroy`
Destroy a specific machine.
```
Inputs:  { app: string, machine_id: string, force?: bool }
Outputs: { success: bool }
Command: fly machines destroy <machine_id> -a <app> [--force]
Guard:   assertNotRouter(app)
```

#### `fly_scale_count`
Scale machine count.
```
Inputs:  { app: string, count: number, region?: string, process_group?: string }
Outputs: { success: bool }
Command: fly scale count <count> -a <app> [--region <r>] [--process-group <g>]
Guard:   assertNotRouter(app)
Guard:   count >= 0 and <= 20
```

#### `fly_scale_vm`
Change VM size.
```
Inputs:  { app: string, size: string, memory?: number }
Outputs: { success: bool }
Command: fly scale vm <size> -a <app> [--vm-memory <m>]
Guard:   assertNotRouter(app)
```

#### `fly_volumes_create`
Create a volume.
```
Inputs:  { app: string, region: string, size_gb?: number, name?: string }
Outputs: Volume
Command: fly volumes create <name> -a <app> --region <r> --size <s> --json --yes
Guard:   assertNotRouter(app)
```

#### `fly_volumes_destroy`
Destroy a volume.
```
Inputs:  { app: string, volume_id: string, confirm: string }
Outputs: { success: bool }
Command: fly volumes destroy <volume_id> -a <app> --yes
Guard:   assertNotRouter(app)
Guard:   confirm must exactly equal volume_id
```

#### `fly_ip_allocate_flycast`
Allocate a private Flycast IPv6 on an explicit network.
This is the **ONLY** IP allocation tool. No other IP allocation path exists.
```
Inputs:  { app: string, network: string }
Outputs: FlyIp
Command: fly ips allocate-v6 --private --network <network> -a <app>
Enforce: --private ALWAYS passed                                  [Rule 2]
Enforce: --network ALWAYS passed, REQUIRED input (not optional)   [Rule 1]
Note:    allocate-v4, allocate (recommended), bare allocate-v6 — NEVER invoked
```

The `network` input is **required**, not optional, not defaulted. The caller
must explicitly name which private network will have access. This forces
intentionality: "I am making this app reachable from the `browsers` network."

#### `fly_ip_release`
Release an IP from an app. Used for cleanup / removing public IPs.
```
Inputs:  { app: string, address: string }
Outputs: { success: bool }
Command: fly ips release <address> -a <app>
Guard:   assertNotRouter(app)
```

---

## Blocked Commands (Never Exposed)

| Command | Rule | Reason |
|---|---|---|
| `fly ips allocate-v4` | 2 | Public IPv4 |
| `fly ips allocate-v6` (no `--private`) | 2 | Public IPv6 |
| `fly ips allocate` | 2 | Recommended (public) IPs |
| `fly machine create/run/update --port` | 2,3 | Public port exposure |
| `fly auth login/logout` | — | Interactive; not MCP-appropriate |
| `fly ssh console` | — | Interactive shell |
| `fly proxy` | — | Long-running tunnel |
| `fly wireguard *` | — | Network access control — manual only |
| `fly orgs create/delete` | — | Org management out of scope |
| `fly apps destroy` on `ambit-*` | — | Router managed by ambit CLI |
| `fly certs *` | 2 | Implies public TLS termination |
| `fly deploy` without `--no-public-ips` | 2 | Structurally impossible |
| `fly deploy` without `--flycast` | 3 | Structurally impossible |

---

## Resources (MCP Read-Only Context)

#### `ambit://config`
The current ambit configuration (network, org, region, router app).
Read from `~/.config/ambit/config.json`.

#### `ambit://network-info`
Derived info: network name, TLD, router app name, subnet, tag.
Helps agents understand the environment they're operating in.

---

## Safety Layer Implementation

### Command Executor

All flyctl invocations go through a single `execFly()` function:

```typescript
interface FlyCommand {
  args: string[];
  parse?: ZodSchema;
  audit?: AuditCheck;
}

interface AuditCheck {
  kind: "no_public_ips";
  app: string;
}
```

The executor:
1. Validates args against a **subcommand allowlist** (only known patterns)
2. Rejects if any arg matches the **flag blocklist**: `--port`, `-p`
3. Asserts enforced flags are present when expected
   (`--no-public-ips` on deploy, `--private` + `--network` on allocate-v6)
4. Runs the command via `Deno.Command`
5. Parses stdout through Zod if `parse` is set
6. Runs audit check if `audit` is set
7. Returns typed result or structured error

### App Name Guard

```typescript
function assertNotRouter(app: string): void {
  if (app.startsWith("ambit-")) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Cannot operate on ambit infrastructure apps. Use the ambit CLI."
    );
  }
}
```

### Deploy Auditor

```typescript
interface DeployAuditResult {
  public_ips_released: number;
  flycast_allocations: Array<{ address: string; network: string }>;
  config_warnings: string[];
}

async function auditDeploy(app: string): Promise<DeployAuditResult> {
  const result: DeployAuditResult = {
    public_ips_released: 0,
    flycast_allocations: [],
    config_warnings: [],
  };

  // Phase 1: Check and clean IPs
  const ips = await execFly({
    args: ["ips", "list", "-a", app, "--json"],
    parse: FlyIpListSchema,
  });

  for (const ip of ips) {
    if (ip.Type === "private_v6") {
      result.flycast_allocations.push({
        address: ip.Address,
        network: ip.Network || "default",
      });
    } else {
      // Public IP found — release immediately
      await execFly({ args: ["ips", "release", ip.Address, "-a", app] });
      result.public_ips_released++;
    }
  }

  // Phase 2: Inspect merged config for dangerous patterns
  const config = await execFly({
    args: ["config", "show", "-a", app],
  });

  if (config) {
    const parsed = JSON.parse(config.stdout);

    // Check for services that would be public if a public IP were added
    if (parsed.services?.length > 0) {
      const hasTlsHandler = parsed.services.some((svc: any) =>
        svc.ports?.some((p: any) =>
          p.handlers?.includes("tls") && p.port === 443
        )
      );
      if (hasTlsHandler) {
        result.config_warnings.push(
          "Service config has TLS handler on port 443. " +
          "This is safe only because no public IPs are allocated. " +
          "Do not add public IPs to this app."
        );
      }
    }

    // Check for force_https which implies public expectation
    if (parsed.http_service?.force_https) {
      result.config_warnings.push(
        "http_service.force_https is enabled. This has no effect on Flycast " +
        "and suggests the config may have been written for public deployment."
      );
    }
  }

  // Phase 3: Verify Flycast allocation exists
  if (result.flycast_allocations.length === 0) {
    result.config_warnings.push(
      "No Flycast IP allocated. The app is not reachable via Flycast. " +
      "Use fly_ip_allocate_flycast to allocate one."
    );
  }

  return result;
}
```

### Pre-flight Config Scanner

```typescript
interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function scanFlyToml(tomlContent: string): PreflightResult {
  const result: PreflightResult = { ok: true, errors: [], warnings: [] };
  const config = parseTOML(tomlContent);

  // Reject: force_https implies public deployment intent
  if (config.http_service?.force_https === true) {
    result.ok = false;
    result.errors.push(
      "[http_service].force_https = true — this implies public HTTPS. " +
      "Flycast does not use force_https. Remove it."
    );
  }

  // Reject: standard public HTTPS pattern (443 with tls+http handlers)
  for (const svc of config.services || []) {
    for (const port of svc.ports || []) {
      if (port.port === 443 && port.handlers?.includes("tls")) {
        result.ok = false;
        result.errors.push(
          `[[services]] port 443 with TLS handler — this is the standard ` +
          `public HTTPS config. Remove it or reconfigure for Flycast-only.`
        );
      }
    }
  }

  // Warn: services block is present (fine for Flycast, but flag it)
  if (config.services?.length > 0) {
    result.warnings.push(
      "[[services]] block present — verify it defines internal " +
      "ports for Flycast routing, not public service exposure."
    );
  }

  return result;
}
```

---

## File Structure

```
ambit-mcp/
├── main.ts                  # McpServer setup, register tools/resources, stdio
├── deno.json                # Workspace member config
├── design.md                # This document
│
├── src/
│   ├── executor.ts          # Safe flyctl executor (allowlist, blocklist, enforced flags)
│   ├── config.ts            # Load ambit config, derive network/org/tag
│   ├── guard.ts             # assertNotRouter, auditDeploy, scanFlyToml
│   ├── schemas/
│   │   ├── fly.ts           # Zod schemas for fly CLI JSON output
│   │   └── inputs.ts        # Zod schemas for MCP tool input validation
│   └── tools/
│       ├── auth.ts          # fly_auth_status
│       ├── apps.ts          # fly_app_list, fly_app_create, fly_app_destroy, fly_app_status
│       ├── machines.ts      # fly_machine_list, fly_machine_start/stop/destroy
│       ├── deploy.ts        # fly_deploy (pre-flight + --no-public-ips --flycast + post-audit)
│       ├── ips.ts           # fly_ip_list, fly_ip_allocate_flycast, fly_ip_release
│       ├── secrets.ts       # fly_secrets_list, fly_secrets_set, fly_secrets_unset
│       ├── scale.ts         # fly_scale_show, fly_scale_count, fly_scale_vm
│       ├── volumes.ts       # fly_volumes_list, fly_volumes_create, fly_volumes_destroy
│       ├── config.ts        # fly_config_show
│       └── logs.ts          # fly_logs
│
└── main_test.ts             # Tests
```

---

## Configuration

On startup, reads `~/.config/ambit/config.json`:

```typescript
interface ambitConfig {
  network: string;            // "browsers"
  router: {
    appName: string;          // "ambit-browsers-abc123"
    tailscaleIp?: string;     // "100.x.y.z"
  };
  fly: {
    org: string;              // "my-org"
    region: string;           // "iad"
  };
  tailscale: {
    apiKey: string;           // "tskey-api-..."
  };
}
```

If missing, most tools return an error directing to `ambit deploy`.

---

## Invariants (Always True)

1. **Explicit network on every Flycast allocation** — `fly ips allocate-v6`
   always has `--private --network <name>`. The network is a required input,
   not inferred. You always know who can reach what.

2. **No public IPs, no public ports, no public certs** — the server cannot
   construct a command that allocates a public address or exposes a port.

3. **Flycast-only exposure** — `fly deploy` always passes `--flycast`.
   Post-deploy audit verifies at least one Flycast allocation exists.

4. **Deploy-time auditing catches everything else** — pre-flight rejects
   dangerous fly.toml patterns; post-flight releases any public IPs and
   inspects the live config for exposure signals.

5. **Router-protected** — no tool can target `ambit-*` apps.

6. **Auth-gated** — unauthenticated state fails cleanly on every tool.

---

## Implementation Order

1. **`src/executor.ts`** + **`src/guard.ts`** — safety foundation (flag enforcement,
   assertNotRouter, auditDeploy, scanFlyToml)
2. **`src/config.ts`** + **`src/schemas/fly.ts`** — config loading, Zod schemas
3. **Read-only tools** — auth, app list, machine list, ip list, logs
4. **`fly_deploy`** — the hardest tool: pre-flight scan → deploy with enforced
   flags → post-flight audit → release violations → return audit result
5. **`fly_ip_allocate_flycast`** — with required `--network`
6. **Remaining mutations** — apps, secrets, scale, volumes
7. **Resources** — `ambit://config`, `ambit://network-info`
8. **Tests** — mock executor; verify flag injection; verify pre-flight rejects
   dangerous toml; verify post-flight releases public IPs
