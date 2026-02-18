// =============================================================================
// ambit-mcp: Tool Definitions
// =============================================================================
// Two modes controlled by a CLI flag:
//   --safe    (default) Private-networking enforced. Flycast-only. Router mgmt.
//   --unsafe            Full flyctl surface. No enforcement. No router tools.
//
// Tool categories:
//   common    — identical in both modes (read-only, basic mutations)
//   templated — same base definition, mode-specific description/schema overrides
//   safe-only — router infrastructure, flycast-only IP allocation
//   unsafe-only — public IPs, certs, unrestricted deploy
// =============================================================================

import { z } from "@zod/zod";

// =============================================================================
// Types
// =============================================================================

export type Mode = "safe" | "unsafe";

export interface ToolDef {
  description: string;
  inputSchema: Record<string, z.ZodType>;
  outputSchema: Record<string, z.ZodType>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}

type ToolMap = Record<string, ToolDef>;

// =============================================================================
// Annotations
// =============================================================================

const readOnly = { annotations: { readOnlyHint: true, destructiveHint: false } };
const mutation = { annotations: { readOnlyHint: false, destructiveHint: false } };
const destructive = { annotations: { readOnlyHint: false, destructiveHint: true } };

// =============================================================================
// Shared Input Schemas
// =============================================================================
// Reusable fragments. Every tool that takes "app" uses the same field, etc.
// =============================================================================

const inputs = {
  app: z.string()
    .describe("The Fly.io app name."),
  org: z.string().optional()
    .describe("Fly.io organization slug. If omitted and only one org exists, it is used automatically."),
  region: z.string().optional()
    .describe("Fly.io region (e.g. 'iad', 'sea', 'lhr')."),
  machine_id: z.string()
    .describe("The machine ID (from fly_machine_list)."),
  network: z.string()
    .describe("The custom private network name (e.g. 'browsers', 'infra')."),
  volume_id: z.string()
    .describe("The volume ID (from fly_volumes_list)."),
  address: z.string()
    .describe("The exact IP address (from fly_ip_list)."),
};

const deployInputs = {
  app: inputs.app.describe("The Fly.io app name to deploy to. Must already exist (use fly_app_create first)."),
  image: z.string().optional()
    .describe("Docker image to deploy (e.g. 'registry.fly.io/my-app:latest'). Mutually exclusive with dockerfile."),
  dockerfile: z.string().optional()
    .describe("Path to a Dockerfile to build and deploy. Mutually exclusive with image."),
  region: z.string().optional()
    .describe("Primary region for the deployment (e.g. 'iad', 'sea', 'lhr'). Defaults to config region."),
  strategy: z.enum(["canary", "rolling", "bluegreen", "immediate"]).optional()
    .describe("Deployment strategy. 'rolling' (default) replaces machines gradually. 'immediate' replaces all at once. 'canary' tests on one machine first. 'bluegreen' spins up a full parallel set."),
  env: z.record(z.string(), z.string()).optional()
    .describe("Environment variables as KEY: VALUE pairs. NOT secrets — use fly_secrets_set for sensitive values."),
  build_args: z.record(z.string(), z.string()).optional()
    .describe("Docker build-time arguments as KEY: VALUE pairs. Only used when building from a Dockerfile."),
};

// =============================================================================
// Shared Output Schema Fragments
// =============================================================================

const machineOutput = z.object({
  id: z.string(),
  name: z.string().optional(),
  state: z.string(),
  region: z.string(),
  private_ip: z.string().optional(),
});

const ipOutput = z.object({
  address: z.string(),
  type: z.string(),
  region: z.string().optional(),
  network: z.string().optional(),
  created_at: z.string().optional(),
});

const logEntryOutput = z.object({
  timestamp: z.string(),
  level: z.string().optional(),
  message: z.string(),
  region: z.string().optional(),
  instance: z.string().optional(),
});

// =============================================================================
// Common Tools
// =============================================================================
// Identical in both safe and unsafe modes.
// =============================================================================

const common: ToolMap = {

  fly_auth_status: {
    description:
      `Check whether the fly CLI is authenticated and return the current user ` +
      `identity. Returns the email address associated with the active session. ` +
      `If not authenticated, returns authenticated: false — the MCP server ` +
      `cannot perform interactive login; the user must run 'fly auth login' ` +
      `in their terminal first.`,
    inputSchema: {},
    outputSchema: {
      authenticated: z.boolean(),
      email: z.string().optional(),
    },
    ...readOnly,
  },

  fly_app_status: {
    description:
      `Get detailed status of a specific app including its deployment state, ` +
      `hostname, and list of machines with their states, regions, and IPs. ` +
      `Use this to check whether an app is deployed and its machines are ` +
      `running before interacting with it.`,
    inputSchema: { app: inputs.app },
    outputSchema: {
      id: z.string(),
      name: z.string(),
      status: z.string(),
      deployed: z.boolean(),
      hostname: z.string(),
      machines: z.array(machineOutput),
    },
    ...readOnly,
  },

  fly_machine_list: {
    description:
      `List all machines (VMs) for a Fly.io app. Each machine entry includes ` +
      `its ID, name, state (started/stopped/suspended/destroyed), region, ` +
      `private IPv6 address, and VM configuration (CPU, memory). Use this ` +
      `to see what's running and get machine IDs for start/stop/destroy ` +
      `operations.`,
    inputSchema: { app: inputs.app },
    outputSchema: {
      machines: z.array(machineOutput.extend({
        cpu_kind: z.string().optional(),
        cpus: z.number().optional(),
        memory_mb: z.number().optional(),
      })),
    },
    ...readOnly,
  },

  fly_machine_start: {
    description:
      `Start a stopped or suspended machine. The machine must already exist ` +
      `and be in a stopped/suspended state. Use fly_machine_list to get the ` +
      `machine ID first.`,
    inputSchema: { app: inputs.app, machine_id: inputs.machine_id },
    outputSchema: {
      ok: z.boolean(),
      machine_id: z.string(),
    },
    ...mutation,
  },

  fly_machine_stop: {
    description:
      `Stop a running machine gracefully. The machine is sent a SIGTERM and ` +
      `given time to shut down. Stopped machines can be restarted with ` +
      `fly_machine_start.`,
    inputSchema: { app: inputs.app, machine_id: inputs.machine_id },
    outputSchema: {
      ok: z.boolean(),
      machine_id: z.string(),
    },
    ...mutation,
  },

  fly_machine_destroy: {
    description:
      `Permanently destroy a machine. This deletes the VM and its local ` +
      `(non-volume) state. Volumes attached to the machine are NOT destroyed. ` +
      `Use force: true to kill a machine that won't stop gracefully. ` +
      `This cannot be undone.`,
    inputSchema: {
      app: inputs.app,
      machine_id: inputs.machine_id,
      force: z.boolean().optional()
        .describe("Force-kill the machine regardless of current state. Use when a machine is stuck."),
    },
    outputSchema: {
      ok: z.boolean(),
      machine_id: z.string(),
    },
    ...destructive,
  },

  fly_machine_exec: {
    description:
      `Execute a single command on a running machine and return its output. ` +
      `Useful for debugging: inspect files, check process state, test ` +
      `connectivity, read environment variables, etc.\n\n` +
      `This is NOT an interactive shell — the command runs once and output ` +
      `is returned. For complex debugging, chain commands with '&&' or ` +
      `use 'sh -c "..."'.`,
    inputSchema: {
      app: inputs.app,
      machine_id: inputs.machine_id,
      command: z.array(z.string())
        .describe("The command as an array of arguments. Example: ['ls', '-la', '/app'] or ['sh', '-c', 'ps aux | grep node']."),
    },
    outputSchema: {
      stdout: z.string(),
      stderr: z.string(),
      exit_code: z.number(),
    },
    ...readOnly,
  },

  fly_ip_list: {
    description:
      `List all IP addresses allocated to an app. Each entry shows the ` +
      `address, type (private_v6 for Flycast, v4/v6 for public), region, ` +
      `and network. Use this to audit an app's network exposure.`,
    inputSchema: { app: inputs.app },
    outputSchema: {
      ips: z.array(ipOutput),
    },
    ...readOnly,
  },

  fly_ip_release: {
    description:
      `Release (deallocate) an IP address from an app. Use this to remove ` +
      `unwanted IPs discovered via fly_ip_list. Provide the exact IP ` +
      `address string as shown in fly_ip_list output.`,
    inputSchema: { app: inputs.app, address: inputs.address },
    outputSchema: {
      ok: z.boolean(),
      address: z.string(),
    },
    ...destructive,
  },

  fly_secrets_list: {
    description:
      `List the names, digests, and creation timestamps of secrets set on ` +
      `an app. Secret VALUES are never returned — only metadata. Use this ` +
      `to verify which secrets are configured before deploying.`,
    inputSchema: { app: inputs.app },
    outputSchema: {
      secrets: z.array(z.object({
        name: z.string(),
        digest: z.string(),
        created_at: z.string(),
      })),
    },
    ...readOnly,
  },

  fly_secrets_set: {
    description:
      `Set one or more encrypted secrets on an app. Secrets are encrypted ` +
      `at rest and injected as environment variables into machines at boot. ` +
      `By default, setting secrets triggers a redeployment. Use stage: true ` +
      `to set secrets without redeploying.\n\n` +
      `IMPORTANT: Pass sensitive values (API keys, tokens, passwords) as ` +
      `secrets, NOT as env vars in fly_deploy.`,
    inputSchema: {
      app: inputs.app,
      secrets: z.record(z.string(), z.string())
        .describe("Secrets as KEY: VALUE pairs. Example: { 'DATABASE_URL': 'postgres://...', 'API_KEY': 'sk-...' }."),
      stage: z.boolean().optional()
        .describe("If true, secrets are staged but NOT deployed. They take effect on the next fly_deploy."),
    },
    outputSchema: {
      ok: z.boolean(),
      count: z.number(),
    },
    ...mutation,
  },

  fly_secrets_unset: {
    description:
      `Remove one or more secrets from an app. The app is redeployed to ` +
      `pick up the change.`,
    inputSchema: {
      app: inputs.app,
      keys: z.array(z.string())
        .describe("Secret names to remove. Example: ['OLD_API_KEY', 'DEPRECATED_TOKEN']."),
    },
    outputSchema: {
      ok: z.boolean(),
      count: z.number(),
    },
    ...mutation,
  },

  fly_scale_show: {
    description:
      `Show the current VM size, process groups, and machine counts for ` +
      `an app. Returns CPU kind, CPU count, memory, and how many machines ` +
      `are running per process group and region.`,
    inputSchema: { app: inputs.app },
    outputSchema: {
      processes: z.array(z.object({
        name: z.string(),
        count: z.number(),
        cpu_kind: z.string(),
        cpus: z.number(),
        memory_mb: z.number(),
        regions: z.record(z.string(), z.number()).optional(),
      })),
    },
    ...readOnly,
  },

  fly_scale_count: {
    description:
      `Set the number of machines for an app. Fly.io will create or destroy ` +
      `machines to match the target count. Can be scoped to a specific ` +
      `region or process group. Count is capped at 20 as a safety limit.`,
    inputSchema: {
      app: inputs.app,
      count: z.number().int().min(0).max(20)
        .describe("Target number of machines. 0 removes all machines. Max 20."),
      region: inputs.region.describe("Only scale in this region. Without this, scales across all regions."),
      process_group: z.string().optional()
        .describe("Only scale this process group (e.g. 'app', 'worker'). Without this, scales the default group."),
    },
    outputSchema: {
      ok: z.boolean(),
    },
    ...mutation,
  },

  fly_scale_vm: {
    description:
      `Change the VM size for an app's machines. Common sizes: ` +
      `'shared-cpu-1x', 'shared-cpu-2x', 'shared-cpu-4x', ` +
      `'performance-1x', 'performance-2x', etc.`,
    inputSchema: {
      app: inputs.app,
      size: z.string()
        .describe("VM size name (e.g. 'shared-cpu-1x', 'performance-1x')."),
      memory: z.number().int().optional()
        .describe("Override memory in MB. If not set, uses the default for the VM size."),
    },
    outputSchema: {
      ok: z.boolean(),
    },
    ...mutation,
  },

  fly_volumes_list: {
    description:
      `List all volumes attached to an app. Each entry includes ID, name, ` +
      `size, region, state, and which machine it's attached to.`,
    inputSchema: { app: inputs.app },
    outputSchema: {
      volumes: z.array(z.object({
        id: z.string(),
        name: z.string(),
        state: z.string(),
        size_gb: z.number(),
        region: z.string(),
        encrypted: z.boolean(),
        attached_machine_id: z.string().nullable().optional(),
      })),
    },
    ...readOnly,
  },

  fly_volumes_create: {
    description:
      `Create a persistent volume for an app. Volumes are region-specific ` +
      `and can only be attached to machines in the same region. Encrypted ` +
      `by default. Mount in fly.toml via [[mounts]].`,
    inputSchema: {
      app: inputs.app,
      name: z.string().optional()
        .describe("Volume name. Used in fly.toml [[mounts]] source field. Defaults to 'data'."),
      region: z.string()
        .describe("Region to create the volume in (e.g. 'iad'). Must match where machines run."),
      size_gb: z.number().int().min(1).max(500).optional()
        .describe("Volume size in gigabytes. Default: 1 GB. Max: 500 GB."),
    },
    outputSchema: {
      id: z.string(),
      name: z.string(),
      size_gb: z.number(),
      region: z.string(),
    },
    ...mutation,
  },

  fly_volumes_destroy: {
    description:
      `Permanently destroy a volume. ALL DATA is lost and cannot be ` +
      `recovered. The 'confirm' parameter must exactly match the volume ID.`,
    inputSchema: {
      app: inputs.app,
      volume_id: inputs.volume_id,
      confirm: z.string()
        .describe("Must exactly match the volume_id. Safety confirmation to prevent accidental data loss."),
    },
    outputSchema: {
      ok: z.boolean(),
      volume_id: z.string(),
    },
    ...destructive,
  },

  fly_config_show: {
    description:
      `Show the merged platform configuration for an app. This is the live ` +
      `config Fly.io is running — fly.toml merged with platform defaults. ` +
      `Includes services, mounts, VM config, env, health checks.`,
    inputSchema: { app: inputs.app },
    outputSchema: {
      config: z.record(z.string(), z.unknown()),
    },
    ...readOnly,
  },

  fly_logs: {
    description:
      `Fetch recent log output from an app's machines. Returns the log ` +
      `buffer (not a stream) as structured JSON entries. Can be filtered ` +
      `by region or machine.\n\n` +
      `For ongoing debugging, call repeatedly — each call fetches the ` +
      `latest buffer. This is a polling pattern, not a stream.`,
    inputSchema: {
      app: inputs.app,
      region: inputs.region.describe("Filter logs to a specific region."),
      machine: z.string().optional()
        .describe("Filter logs to a specific machine ID."),
    },
    outputSchema: {
      entries: z.array(logEntryOutput),
    },
    ...readOnly,
  },
};

// =============================================================================
// Templated Tools
// =============================================================================
// These share a common base but differ between safe and unsafe modes.
// Each template is a function (mode) => partial ToolMap.
// =============================================================================

function appListTool(mode: Mode): ToolMap {
  const base =
    `List all Fly.io apps in the organization. Each app includes its ` +
    `name, status, and organization.`;
  const safe =
    ` Results exclude ambit infrastructure apps (ambit-* prefix).`;

  return {
    fly_app_list: {
      description: base + (mode === "safe" ? safe : ""),
      inputSchema: { org: inputs.org },
      outputSchema: {
        apps: z.array(z.object({
          name: z.string(),
          status: z.string(),
          deployed: z.boolean(),
          hostname: z.string(),
          org: z.string(),
        })),
      },
      ...readOnly,
    },
  };
}

function appCreateTool(mode: Mode): ToolMap {
  if (mode === "safe") {
    return {
      fly_app_create: {
        description:
          `Create a new Fly.io app on the configured custom private network. ` +
          `The app is created with NO public IPs — it is only reachable via ` +
          `Flycast from the specified private network. After creation, use ` +
          `fly_deploy to deploy code and fly_ip_allocate_flycast to make it ` +
          `reachable. The --network flag is always set to the configured ` +
          `ambit network to ensure the app lives on the correct 6PN.`,
        inputSchema: {
          name: z.string()
            .describe("Name for the new app. Must be globally unique on Fly.io."),
          org: inputs.org,
        },
        outputSchema: {
          name: z.string(),
          network: z.string(),
          org: z.string(),
        },
        ...mutation,
      },
    };
  }

  return {
    fly_app_create: {
      description:
        `Create a new Fly.io app. Optionally place it on a custom private ` +
        `network (6PN) using the network parameter. Without a network, the ` +
        `app joins the organization's default network.`,
      inputSchema: {
        name: z.string()
          .describe("Name for the new app. Must be globally unique on Fly.io."),
        org: inputs.org,
        network: z.string().optional()
          .describe("Custom private network name. If set, the app is created on this 6PN via --network."),
      },
      outputSchema: {
        name: z.string(),
        network: z.string().optional(),
        org: z.string(),
      },
      ...mutation,
    },
  };
}

function appDestroyTool(mode: Mode): ToolMap {
  const base =
    `Permanently destroy a Fly.io app and all its machines, volumes, and ` +
    `IP allocations. This cannot be undone.`;
  const safe =
    ` Cannot target ambit infrastructure apps (ambit-* prefix).`;

  return {
    fly_app_destroy: {
      description: base + (mode === "safe" ? safe : ""),
      inputSchema: { app: inputs.app },
      outputSchema: {
        ok: z.boolean(),
        app: z.string(),
      },
      ...destructive,
    },
  };
}

function deployTool(mode: Mode): ToolMap {
  if (mode === "safe") {
    return {
      fly_deploy: {
        description:
          `Deploy an app from a Docker image or Dockerfile.\n\n` +
          `Safety enforcement:\n` +
          `- --no-public-ips is ALWAYS passed (no public IP allocation)\n` +
          `- --flycast is ALWAYS passed (ensures Flycast private IPv6)\n` +
          `- Pre-flight: if a local fly.toml is found, it is scanned for ` +
          `dangerous config patterns (force_https, public TLS handlers)\n` +
          `- Post-flight: fly ips list is checked — any public IPs are ` +
          `released immediately and the deploy is flagged as an error\n` +
          `- Post-flight: fly config show is inspected for exposure signals\n\n` +
          `Returns an audit result with public IPs found/released, Flycast ` +
          `allocations with their target networks, and config warnings.`,
        inputSchema: { ...deployInputs },
        outputSchema: {
          ok: z.boolean(),
          audit: z.object({
            public_ips_released: z.number(),
            flycast_allocations: z.array(z.object({
              address: z.string(),
              network: z.string(),
            })),
            warnings: z.array(z.string()),
          }),
        },
        ...mutation,
      },
    };
  }

  return {
    fly_deploy: {
      description:
        `Deploy an app from a Docker image or Dockerfile. This is the ` +
        `primary way to push code to a Fly.io app. Supports all deployment ` +
        `strategies and configuration options.\n\n` +
        `The no_public_ips and flycast flags control network exposure. ` +
        `Set no_public_ips: true to prevent public IP allocation. Set ` +
        `flycast: true to allocate a private Flycast IPv6 address.`,
      inputSchema: {
        ...deployInputs,
        no_public_ips: z.boolean().optional()
          .describe("If true, pass --no-public-ips to prevent public IP allocation on deploy."),
        flycast: z.boolean().optional()
          .describe("If true, pass --flycast to allocate a private Flycast IPv6 address."),
        ha: z.boolean().optional()
          .describe("If false, disable high-availability (skip creating spare machines). Default: true."),
      },
      outputSchema: {
        ok: z.boolean(),
      },
      ...mutation,
    },
  };
}

function ipAllocateTools(mode: Mode): ToolMap {
  if (mode === "safe") {
    return {
      fly_ip_allocate_flycast: {
        description:
          `Allocate a private Flycast IPv6 address for an app, reachable ` +
          `from a specific custom private network. This is the ONLY way to ` +
          `make an app reachable — there is no public IP allocation.\n\n` +
          `The 'network' parameter is REQUIRED — you must explicitly name ` +
          `which private network will be able to reach this app.\n\n` +
          `Note: Flycast exposes the app to a DIFFERENT network than the ` +
          `one it lives on. If the app is on network 'alpha' and you ` +
          `allocate with network 'beta', then machines on 'beta' can ` +
          `reach it via '<app>.flycast'.\n\n` +
          `For ambit setups, the network should typically be the ` +
          `ambit network name so the Tailscale router can reach the app.`,
        inputSchema: {
          app: inputs.app,
          network: inputs.network
            .describe("The custom private network that will be able to reach this app via Flycast. REQUIRED."),
        },
        outputSchema: {
          address: z.string(),
          type: z.string(),
          network: z.string(),
        },
        ...mutation,
      },
    };
  }

  return {
    fly_ip_allocate_v6: {
      description:
        `Allocate an IPv6 address for an app. Can be public or private.\n\n` +
        `For a private Flycast address, set private: true. To make the ` +
        `app reachable from a specific custom network, also pass the ` +
        `network name. Without private: true, this allocates a PUBLIC ` +
        `IPv6 visible on the internet.\n\n` +
        `For cross-org Flycast, use the org parameter to specify the ` +
        `requesting organization.`,
      inputSchema: {
        app: inputs.app,
        private: z.boolean().optional()
          .describe("If true, allocate a private Flycast IPv6 (--private). If false/omitted, allocates a PUBLIC IPv6."),
        network: z.string().optional()
          .describe("Custom network name for Flycast (--network). Only used with private: true."),
        region: inputs.region,
        org: inputs.org.describe("For cross-org Flycast: the organization that will access this app."),
      },
      outputSchema: {
        address: z.string(),
        type: z.string(),
        region: z.string().optional(),
        network: z.string().optional(),
      },
      ...mutation,
    },

    fly_ip_allocate_v4: {
      description:
        `Allocate a public IPv4 address for an app. This makes the app ` +
        `reachable from the public internet over IPv4. Use shared: true ` +
        `for a cheaper shared address (sufficient for most apps).`,
      inputSchema: {
        app: inputs.app,
        shared: z.boolean().optional()
          .describe("If true, allocate a shared IPv4 (cheaper, sufficient for most use cases)."),
        region: inputs.region,
      },
      outputSchema: {
        address: z.string(),
        type: z.string(),
        region: z.string().optional(),
        network: z.string().optional(),
      },
      ...mutation,
    },
  };
}

// =============================================================================
// Safe-Only Tools
// =============================================================================
// Router management + network safety auditing.
// Only available in --safe mode.
// =============================================================================

const safeOnly: ToolMap = {

  router_list: {
    description:
      `Discover all ambit subnet routers in the organization. Each ` +
      `router bridges one Fly.io custom private network (6PN) to your ` +
      `Tailscale tailnet. Returns network name, Fly app name, region, ` +
      `machine state, private IP, /48 subnet, and Tailscale device status.\n\n` +
      `Discovery-based — queries Fly Machines REST API for ambit-* apps ` +
      `on non-default networks, then cross-references with Tailscale.`,
    inputSchema: { org: inputs.org },
    outputSchema: {
      routers: z.array(z.object({
        network: z.string(),
        app_name: z.string(),
        region: z.string().optional(),
        machine_state: z.string().optional(),
        private_ip: z.string().optional(),
        subnet: z.string().optional(),
      })),
    },
    ...readOnly,
  },

  router_status: {
    description:
      `Detailed status of a specific router by network name. Returns Fly ` +
      `app name, region, machine state, private IPv6, /48 subnet, Tailscale ` +
      `device info (IP, online, advertised/enabled routes), and split DNS.\n\n` +
      `The network name is the TLD used to reach apps — e.g. 'browsers' ` +
      `means apps are at '<app>.browsers'.`,
    inputSchema: { network: inputs.network, org: inputs.org },
    outputSchema: {
      network: z.string(),
      app_name: z.string(),
      region: z.string().optional(),
      machine_state: z.string().optional(),
      private_ip: z.string().optional(),
      subnet: z.string().optional(),
      tag: z.string().optional(),
    },
    ...readOnly,
  },

  router_deploy: {
    description:
      `Deploy a new Tailscale subnet router to a Fly.io custom private ` +
      `network. Creates the bridge that makes all Flycast apps on the ` +
      `network reachable from your tailnet as '<app>.<network>'.\n\n` +
      `Steps: create Fly app on custom 6PN → set secrets → deploy router ` +
      `container → wait for tailnet join → configure split DNS → enable ` +
      `accept-routes locally.\n\n` +
      `Prerequisites: fly CLI authenticated, Tailscale running locally, ` +
      `Tailscale API access token in credential store ` +
      `(~/.config/ambit/credentials.json) or TAILSCALE_API_KEY env var.`,
    inputSchema: {
      network: inputs.network
        .describe("Custom private network name. Becomes the TLD on your tailnet (e.g. 'browsers' → '<app>.browsers')."),
      org: inputs.org,
      region: inputs.region.describe("Region for the router machine. Default: 'iad'."),
      self_approve: z.boolean().optional()
        .describe("If true, approve subnet routes via Tailscale API instead of relying on autoApprovers in the ACL policy."),
    },
    outputSchema: {
      network: z.string(),
      app_name: z.string(),
      tag: z.string().optional(),
      subnet: z.string().optional(),
    },
    ...mutation,
  },

  router_destroy: {
    description:
      `Tear down a router for a specific network. Clears split DNS, ` +
      `removes the Tailscale device, destroys the Fly app.\n\n` +
      `Apps on the network are NOT destroyed — only the router is removed. ` +
      `Re-deploy with router_deploy to restore access.\n\n` +
      `Reminder: remove the router's tag and autoApprovers entries from ` +
      `your Tailscale ACL policy after destroying.`,
    inputSchema: { network: inputs.network, org: inputs.org },
    outputSchema: {
      ok: z.boolean(),
      network: z.string(),
    },
    ...destructive,
  },

  router_doctor: {
    description:
      `Health checks on a specific router or all routers. Returns pass/fail ` +
      `with remediation hints.\n\n` +
      `Checks: Tailscale installed, connected, accept-routes enabled, ` +
      `credentials available, router machine running, device visible in ` +
      `tailnet, routes advertised/enabled, split DNS configured.\n\n` +
      `If network is omitted, checks all discovered routers.`,
    inputSchema: {
      network: z.string().optional()
        .describe("Specific network to check. If omitted, checks all discovered routers."),
      org: inputs.org,
    },
    outputSchema: {
      checks: z.array(z.object({
        name: z.string(),
        passed: z.boolean(),
        hint: z.string().optional(),
      })),
      healthy: z.boolean(),
    },
    ...readOnly,
  },

  router_logs: {
    description:
      `Fetch recent logs from a router's machine. Useful for debugging ` +
      `Tailscale auth, DNS proxy startup, route advertisement, IP ` +
      `forwarding. Router logs use 'Router:' prefix.\n\n` +
      `Returns the log buffer (not a stream) as structured JSON entries.`,
    inputSchema: { network: inputs.network, org: inputs.org },
    outputSchema: {
      entries: z.array(logEntryOutput),
    },
    ...readOnly,
  },
};

// =============================================================================
// Unsafe-Only Tools
// =============================================================================
// Full flyctl surface that doesn't exist in safe mode.
// =============================================================================

const unsafeOnly: ToolMap = {

  fly_certs_list: {
    description:
      `List TLS certificates configured for an app. Certificates are used ` +
      `for custom domains on publicly-accessible apps.`,
    inputSchema: { app: inputs.app },
    outputSchema: {
      certificates: z.array(z.object({
        hostname: z.string(),
        created_at: z.string().optional(),
      })),
    },
    ...readOnly,
  },

  fly_certs_add: {
    description:
      `Add a TLS certificate for a custom domain on an app. The domain must ` +
      `have DNS configured to point to the app's public IP addresses. Fly.io ` +
      `automatically provisions and renews the certificate via ACME.`,
    inputSchema: {
      app: inputs.app,
      hostname: z.string()
        .describe("The custom domain hostname (e.g. 'app.example.com')."),
    },
    outputSchema: {
      hostname: z.string(),
    },
    ...mutation,
  },

  fly_certs_remove: {
    description:
      `Remove a TLS certificate from an app. The custom domain will no ` +
      `longer be served with TLS by Fly Proxy.`,
    inputSchema: {
      app: inputs.app,
      hostname: z.string()
        .describe("The custom domain hostname to remove the certificate for."),
    },
    outputSchema: {
      ok: z.boolean(),
      hostname: z.string(),
    },
    ...destructive,
  },

  fly_ip_allocate: {
    description:
      `Allocate the recommended IP addresses for an app (typically one ` +
      `shared IPv4 and one public IPv6). This is the quick way to make ` +
      `an app publicly accessible.`,
    inputSchema: { app: inputs.app, region: inputs.region },
    outputSchema: {
      ips: z.array(z.object({
        address: z.string(),
        type: z.string(),
      })),
    },
    ...mutation,
  },
};

// =============================================================================
// Builder
// =============================================================================
// Assembles the final tool set for a given mode.
// =============================================================================

export function buildTools(mode: Mode): ToolMap {
  return {
    ...common,
    ...appListTool(mode),
    ...appCreateTool(mode),
    ...appDestroyTool(mode),
    ...deployTool(mode),
    ...ipAllocateTools(mode),
    ...(mode === "safe" ? safeOnly : unsafeOnly),
  };
}

// =============================================================================
// Type Utilities
// =============================================================================

export type ToolName = string;
