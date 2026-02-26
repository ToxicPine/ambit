// =============================================================================
// Fly.io Provider - Wraps flyctl CLI
// =============================================================================

import { runCommand, runJson } from "@/lib/command.ts";
import { Result } from "@/lib/result.ts";
import { commandExists, die } from "@/lib/cli.ts";
import { dirname, resolve } from "@std/path";
import {
  type FlyApp,
  type FlyAppInfo,
  FlyAppInfoListSchema,
  FlyAppsListSchema,
  FlyAuthSchema,
  type FlyIp,
  FlyIpListSchema,
  type FlyMachine,
  FlyMachinesListSchema,
  FlyOrgsSchema,
  FlyStatusSchema,
} from "@/schemas/fly.ts";
import { fileExists } from "@/lib/cli.ts";
import { getWorkloadAppName } from "@/util/naming.ts";
import { extractErrorDetail, getSizeConfig, mapMachines } from "@/util/fly-transforms.ts";

// =============================================================================
// Deploy Error
// =============================================================================

/**
 * Thrown when a `fly deploy` command fails. Carries the raw stderr so callers
 * can surface it through `out` (respecting JSON mode) instead of printing
 * directly.
 */
export class FlyDeployError extends Error {
  /** Last meaningful line from flyctl stderr. */
  readonly detail: string;

  constructor(app: string, stderr: string) {
    const detail = extractErrorDetail(stderr);
    super(`Deploy Failed for '${app}'`);
    this.name = "FlyDeployError";
    this.detail = detail;
  }
}

// =============================================================================
// Machine Configuration
// =============================================================================

export type MachineSize = "shared-cpu-1x" | "shared-cpu-2x" | "shared-cpu-4x";

export interface MachineConfig {
  size: MachineSize;
  memoryMb?: number;
  region?: string;
  autoStopSeconds?: number;
}

// =============================================================================
// Machine Result Type
// =============================================================================

export interface MachineResult {
  id: string;
  state: string;
  size: string;
  region: string;
  privateIp?: string;
}

// =============================================================================
// Safe Deploy Options
// =============================================================================

export interface SafeDeployOptions {
  image?: string;
  config?: string;
  region?: string;
  routerId?: string;
}

// =============================================================================
// Fly Provider Interface
// =============================================================================

export interface FlyProvider {
  auth: {
    ensureInstalled(): Promise<void>;
    login(opts?: { interactive?: boolean }): Promise<string>;
    getToken(): Promise<string>;
  };
  orgs: {
    list(): Promise<Record<string, string>>;
  };
  apps: {
    list(org?: string): Promise<FlyApp[]>;
    listWithNetwork(org: string): Promise<FlyAppInfo[]>;
    create(name: string, org: string, opts?: { network?: string; routerId?: string }): Promise<void>;
    delete(name: string): Promise<void>;
    exists(name: string): Promise<boolean>;
    getConfig(name: string): Promise<Record<string, unknown> | null>;
  };
  machines: {
    list(app: string): Promise<FlyMachine[]>;
    clone(app: string, config: MachineConfig): Promise<MachineResult>;
    destroy(app: string, machineId: string): Promise<void>;
  };
  secrets: {
    set(app: string, secrets: Record<string, string>, opts?: { stage?: boolean }): Promise<void>;
  };
  ips: {
    list(app: string): Promise<FlyIp[]>;
    release(app: string, address: string): Promise<void>;
    allocateFlycast(app: string, network: string): Promise<void>;
  };
  certs: {
    list(app: string): Promise<string[]>;
    remove(app: string, hostname: string): Promise<void>;
  };
  deploy: {
    router(app: string, dir: string, config?: { region?: string }): Promise<void>;
    app(app: string, options: SafeDeployOptions): Promise<void>;
  };
}

// =============================================================================
// Create Fly Provider
// =============================================================================

export const createFlyProvider = (): FlyProvider => {
  const provider: FlyProvider = {
    auth: {
      async ensureInstalled(): Promise<void> {
        if (!(await commandExists("fly"))) {
          return die(
            "Flyctl Not Found. Install from https://fly.io/docs/flyctl/install/",
          );
        }
      },

      async login(opts?: { interactive?: boolean }): Promise<string> {
        const interactive = opts?.interactive ?? true;

        const result = await runCommand(["fly", "auth", "whoami", "--json"]);

        if (result.ok) {
          const auth = result.json<{ email: string }>();
          if (auth.ok) {
            const parsed = FlyAuthSchema.safeParse(auth.value);
            if (parsed.success) {
              return parsed.data.email;
            }
          }
        }

        if (!interactive) {
          return die("Not Authenticated with Fly.io. Run 'fly auth login' First");
        }

        const loginResult = await runCommand(["fly", "auth", "login"], {
          interactive: true,
        });
        if (!loginResult.ok) {
          return die("Fly.io Authentication Failed");
        }

        const checkResult = await runCommand(["fly", "auth", "whoami", "--json"]);
        if (!checkResult.ok) {
          return die("Fly.io Authentication Verification Failed");
        }

        const parsed = FlyAuthSchema.safeParse(
          checkResult.json<unknown>().unwrap(),
        );
        if (!parsed.success || !parsed.data) {
          return die("Fly.io Authentication Response Invalid");
        }

        return parsed.data.email;
      },

      async getToken(): Promise<string> {
        const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
        const configPath = `${home}/.fly/config.yml`;

        if (!(await fileExists(configPath))) {
          return die(
            "Fly Config Not Found at ~/.fly/config.yml. Run 'fly auth login' First",
          );
        }

        const content = await Deno.readTextFile(configPath);
        const match = content.match(/access_token:\s*(.+)/);
        if (!match || !match[1]) {
          return die(
            "No Access Token Found in ~/.fly/config.yml. Run 'fly auth login' First",
          );
        }

        return match[1].trim();
      },
    },

    orgs: {
      async list(): Promise<Record<string, string>> {
        const result = await runJson<Record<string, string>>(
          ["fly", "orgs", "list", "--json"],
        );
        if (!result.ok) {
          return die("Failed to List Organizations");
        }

        const parsed = FlyOrgsSchema.safeParse(result.value);
        if (!parsed.success) {
          return die("Failed to Parse Organizations");
        }

        return parsed.data;
      },
    },

    apps: {
      async list(org?: string): Promise<FlyApp[]> {
        const args = ["fly", "apps", "list", "--json"];
        if (org) {
          args.push("--org", org);
        }

        const result = await runCommand(args);
        return result.json<FlyApp[]>().flatMap((data) => {
          const parsed = FlyAppsListSchema.safeParse(data);
          return parsed.success
            ? Result.ok(parsed.data)
            : Result.err("Parse Failed");
        }).unwrapOr([]);
      },

      async listWithNetwork(org: string): Promise<FlyAppInfo[]> {
        const token = await provider.auth.getToken();

        const response = await fetch(
          `https://api.machines.dev/v1/apps?org_slug=${encodeURIComponent(org)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          },
        );

        if (!response.ok) {
          return die(`Failed to List Apps via REST API: HTTP ${response.status}`);
        }

        const data = await response.json();
        const parsed = FlyAppInfoListSchema.safeParse(data);
        if (!parsed.success) {
          return die("Failed to Parse Apps REST API Response");
        }

        return parsed.data.apps;
      },

      async create(
        name: string,
        org: string,
        opts?: { network?: string; routerId?: string },
      ): Promise<void> {
        const appName = opts?.routerId
          ? getWorkloadAppName(name, opts.routerId)
          : name;
        const args = ["fly", "apps", "create", appName, "--org", org, "--json"];

        if (opts?.network) {
          args.push("--network", opts.network);
        }

        const result = await runCommand(args);

        if (!result.ok) {
          return die(`Failed to Create App '${appName}'`);
        }
      },

      async delete(name: string): Promise<void> {
        const result = await runCommand([
          "fly",
          "apps",
          "destroy",
          name,
          "--yes",
        ]);

        if (!result.ok) {
          return die(`Failed to Delete App '${name}'`);
        }
      },

      async exists(name: string): Promise<boolean> {
        const result = await runCommand(["fly", "status", "-a", name, "--json"]);
        return result.json<{ ID?: string }>().match({
          ok: (data) => {
            const parsed = FlyStatusSchema.safeParse(data);
            return parsed.success && !!parsed.data.ID;
          },
          err: () => false,
        });
      },

      async getConfig(name: string): Promise<Record<string, unknown> | null> {
        const result = await runCommand(["fly", "config", "show", "-a", name]);
        return result.json<Record<string, unknown>>().match({
          ok: (v) => v,
          err: () => null,
        });
      },
    },

    machines: {
      async list(app: string): Promise<FlyMachine[]> {
        const result = await runJson<FlyMachine[]>(
          ["fly", "machines", "list", "-a", app, "--json"],
        );

        return result.flatMap((data) => {
          const parsed = FlyMachinesListSchema.safeParse(data);
          return parsed.success
            ? Result.ok(parsed.data)
            : Result.err("Parse Failed");
        }).unwrapOr([]);
      },

      async clone(
        app: string,
        config: MachineConfig,
      ): Promise<MachineResult> {
        const raw = await provider.machines.list(app);
        const existingMachines = mapMachines(raw);

        if (existingMachines.length === 0) {
          return die("No Existing Machine to Clone. Run 'fly deploy' First");
        }

        const sourceMachine = existingMachines[0];
        const sizeConfig = getSizeConfig(config.size);
        const memoryMb = config.memoryMb ?? sizeConfig.memoryMb;

        const args = [
          "fly",
          "machine",
          "clone",
          sourceMachine.id,
          "-a",
          app,
          "--vm-cpus",
          String(sizeConfig.cpus),
          "--vm-memory",
          String(memoryMb),
        ];

        if (config.region) {
          args.push("--region", config.region);
        }

        const result = await runCommand(args);

        if (!result.ok) {
          return die(result.stderr || "Unknown Error");
        }

        const rawAfter = await provider.machines.list(app);
        const machines = mapMachines(rawAfter);
        const newest = machines[machines.length - 1];

        if (!newest) {
          return die("Created Machine Not Found");
        }

        return newest;
      },

      async destroy(app: string, machineId: string): Promise<void> {
        const shortId = machineId.slice(0, 8);
        const result = await runCommand([
          "fly",
          "machines",
          "destroy",
          machineId,
          "-a",
          app,
          "--force",
        ]);

        if (!result.ok) {
          return die(`Failed to Destroy Machine '${shortId}'`);
        }
      },
    },

    secrets: {
      async set(
        app: string,
        secrets: Record<string, string>,
        opts?: { stage?: boolean },
      ): Promise<void> {
        const pairs = Object.entries(secrets)
          .filter(([_, v]) => v !== undefined && v !== "")
          .map(([k, v]) => `${k}=${v}`);

        if (pairs.length === 0) return;

        const args = ["fly", "secrets", "set", ...pairs, "-a", app];

        if (opts?.stage) {
          args.push("--stage");
        }

        const result = await runCommand(args);

        if (!result.ok) {
          return die("Failed to Set Secrets");
        }
      },
    },

    ips: {
      async list(app: string): Promise<FlyIp[]> {
        const result = await runCommand([
          "fly",
          "ips",
          "list",
          "-a",
          app,
          "--json",
        ]);
        return result.json<FlyIp[]>().flatMap((data) => {
          const parsed = FlyIpListSchema.safeParse(data);
          return parsed.success
            ? Result.ok(parsed.data)
            : Result.err("Parse Failed");
        }).unwrapOr([]);
      },

      async release(app: string, address: string): Promise<void> {
        const result = await runCommand([
          "fly",
          "ips",
          "release",
          address,
          "-a",
          app,
        ]);
        if (!result.ok) {
          return die(`Failed to Release IP ${address} from '${app}'`);
        }
      },

      async allocateFlycast(app: string, network: string): Promise<void> {
        const result = await runCommand([
          "fly",
          "ips",
          "allocate-v6",
          "--private",
          "--network",
          network,
          "-a",
          app,
        ]);
        if (!result.ok) {
          return die(`Failed to Allocate Flycast IP on Network '${network}'`);
        }
      },
    },

    certs: {
      async list(app: string): Promise<string[]> {
        const result = await runCommand([
          "fly",
          "certs",
          "list",
          "-a",
          app,
          "--json",
        ]);
        return result.json<Array<{ Hostname?: string }>>().map((certs) =>
          certs
            .map((c) => c.Hostname)
            .filter((h): h is string => typeof h === "string")
        ).unwrapOr([]);
      },

      async remove(app: string, hostname: string): Promise<void> {
        await runCommand([
          "fly",
          "certs",
          "remove",
          hostname,
          "-a",
          app,
          "--yes",
        ]);
      },
    },

    deploy: {
      async router(
        app: string,
        dockerDir: string,
        config?: { region?: string },
      ): Promise<void> {
        const args = [
          "fly",
          "deploy",
          dockerDir,
          "-a",
          app,
          "--yes",
          "--ha=false",
        ];

        if (config?.region) {
          args.push("--primary-region", config.region);
        }

        const result = await runCommand(args);

        if (!result.ok) {
          throw new FlyDeployError(app, result.stderr);
        }
      },

      async app(appName: string, options: SafeDeployOptions): Promise<void> {
        const flyAppName = options.routerId
          ? getWorkloadAppName(appName, options.routerId)
          : appName;
        const args = ["fly", "deploy"];

        // When config is provided, use its parent directory as the build context
        // so fly deploy finds the Dockerfile and COPY picks up the correct files
        if (options.config) {
          const configAbs = resolve(options.config);
          args.push(dirname(configAbs));
          args.push("--config", configAbs);
        }

        args.push("-a", flyAppName, "--yes", "--no-public-ips");

        if (options.image) {
          args.push("--image", options.image);
        }

        if (options.region) {
          args.push("--primary-region", options.region);
        }

        const result = await runCommand(args);

        if (!result.ok) {
          throw new FlyDeployError(flyAppName, result.stderr);
        }
      },
    },
  };

  return provider;
};
