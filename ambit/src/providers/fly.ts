// =============================================================================
// Fly.io Provider - Wraps flyctl CLI
// =============================================================================

import { runCommand, runJson, runQuiet } from "@/lib/command.ts";
import { Result } from "@/lib/result.ts";
import { commandExists, die, Spinner } from "@/lib/cli.ts";
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
  mapFlyMachineSize,
  mapFlyMachineState,
} from "../schemas/fly.ts";
import { fileExists } from "@/lib/cli.ts";

// =============================================================================
// Constants
// =============================================================================

const ROUTER_APP_PREFIX = "ambit-";

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

/**
 * Pull the last non-empty, non-decoration line from fly stderr.
 * Fly often prints progress lines then the actual error at the end.
 */
const extractErrorDetail = (stderr: string): string => {
  const lines = stderr
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("-->") && l !== "Error");

  return lines[lines.length - 1] ?? "unknown error";
};

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
  ensureInstalled(): Promise<void>;
  ensureAuth(options?: { interactive?: boolean }): Promise<string>;
  listOrgs(): Promise<Record<string, string>>;
  createApp(
    name: string,
    org: string,
    options?: { network?: string; routerId?: string },
  ): Promise<void>;
  deleteApp(name: string): Promise<void>;
  listApps(org?: string): Promise<FlyApp[]>;
  appExists(name: string): Promise<boolean>;
  listMachines(app: string): Promise<FlyMachine[]>;
  listMachinesMapped(app: string): Promise<MachineResult[]>;
  createMachine(app: string, config: MachineConfig): Promise<MachineResult>;
  destroyMachine(app: string, machineId: string): Promise<void>;
  setSecrets(
    app: string,
    secrets: Record<string, string>,
    options?: { stage?: boolean },
  ): Promise<void>;
  routerDeploy(
    app: string,
    dockerfilePath: string,
    config?: { region?: string },
  ): Promise<void>;
  listIps(app: string): Promise<FlyIp[]>;
  releaseIp(app: string, address: string): Promise<void>;
  allocateFlycastIp(app: string, network: string): Promise<void>;
  getConfig(app: string): Promise<Record<string, unknown> | null>;
  deploySafe(app: string, options: SafeDeployOptions): Promise<void>;
  listCerts(app: string): Promise<string[]>;
  removeCert(app: string, hostname: string): Promise<void>;
  getFlyToken(): Promise<string>;
  listAppsWithNetwork(org: string): Promise<FlyAppInfo[]>;
}

// =============================================================================
// Create Fly Provider
// =============================================================================

export const createFlyProvider = (): FlyProvider => {
  return {
    async ensureInstalled(): Promise<void> {
      if (!(await commandExists("fly"))) {
        return die(
          "Flyctl Not Found. Install from https://fly.io/docs/flyctl/install/",
        );
      }
    },

    async ensureAuth(options?: { interactive?: boolean }): Promise<string> {
      const interactive = options?.interactive ?? true;

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

    async listOrgs(): Promise<Record<string, string>> {
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

    async listApps(org?: string): Promise<FlyApp[]> {
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

    async createApp(
      name: string,
      org: string,
      options?: { network?: string; routerId?: string },
    ): Promise<void> {
      const appName = options?.routerId
        ? getWorkloadAppName(name, options.routerId)
        : name;
      const args = ["fly", "apps", "create", appName, "--org", org, "--json"];

      if (options?.network) {
        args.push("--network", options.network);
      }

      const result = await runQuiet("Creating App", args);

      if (!result.ok) {
        return die(`Failed to Create App '${appName}'`);
      }
    },

    async deleteApp(name: string): Promise<void> {
      const result = await runQuiet("Deleting App", [
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

    async appExists(name: string): Promise<boolean> {
      const result = await runCommand(["fly", "status", "-a", name, "--json"]);
      return result.json<{ ID?: string }>().match({
        ok: (data) => {
          const parsed = FlyStatusSchema.safeParse(data);
          return parsed.success && !!parsed.data.ID;
        },
        err: () => false,
      });
    },

    async listMachines(app: string): Promise<FlyMachine[]> {
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

    async listMachinesMapped(app: string): Promise<MachineResult[]> {
      const raw = await this.listMachines(app);
      return raw.map((m: FlyMachine): MachineResult => ({
        id: m.id,
        state: mapFlyMachineState(m.state),
        size: mapFlyMachineSize(m.config?.guest),
        region: m.region,
        privateIp: m.private_ip,
      }));
    },

    async createMachine(
      app: string,
      config: MachineConfig,
    ): Promise<MachineResult> {
      const existingMachines = await this.listMachinesMapped(app);

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

      const spinner = new Spinner();
      spinner.start(`Creating ${config.size} Machine`);

      const result = await runCommand(args);

      if (!result.ok) {
        spinner.fail("Machine Creation Failed");
        return die(result.stderr || "Unknown Error");
      }

      spinner.success(`Created ${config.size} Machine`);

      const machines = await this.listMachinesMapped(app);
      const newest = machines[machines.length - 1];

      if (!newest) {
        return die("Created Machine Not Found");
      }

      return newest;
    },

    async destroyMachine(app: string, machineId: string): Promise<void> {
      const shortId = machineId.slice(0, 8);
      const result = await runQuiet(`Destroying Machine ${shortId}`, [
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

    async setSecrets(
      app: string,
      secrets: Record<string, string>,
      options?: { stage?: boolean },
    ): Promise<void> {
      const pairs = Object.entries(secrets)
        .filter(([_, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${v}`);

      if (pairs.length === 0) return;

      const args = ["fly", "secrets", "set", ...pairs, "-a", app];

      if (options?.stage) {
        args.push("--stage");
      }

      const result = await runQuiet(
        `Setting ${pairs.length} Secret(s)`,
        args,
      );

      if (!result.ok) {
        return die("Failed to Set Secrets");
      }
    },

    async routerDeploy(
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

    async listIps(app: string): Promise<FlyIp[]> {
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

    async releaseIp(app: string, address: string): Promise<void> {
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

    async allocateFlycastIp(app: string, network: string): Promise<void> {
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

    async getConfig(app: string): Promise<Record<string, unknown> | null> {
      const result = await runCommand(["fly", "config", "show", "-a", app]);
      return result.json<Record<string, unknown>>().match({
        ok: (v) => v,
        err: () => null,
      });
    },

    async deploySafe(app: string, options: SafeDeployOptions): Promise<void> {
      const appName = options.routerId
        ? getWorkloadAppName(app, options.routerId)
        : app;
      const args = ["fly", "deploy"];

      // When config is provided, use its parent directory as the build context
      // so fly deploy finds the Dockerfile and COPY picks up the correct files
      if (options.config) {
        const configAbs = resolve(options.config);
        args.push(dirname(configAbs));
        args.push("--config", configAbs);
      }

      args.push("-a", appName, "--yes", "--no-public-ips");

      if (options.image) {
        args.push("--image", options.image);
      }

      if (options.region) {
        args.push("--primary-region", options.region);
      }

      const result = await runCommand(args);

      if (!result.ok) {
        throw new FlyDeployError(appName, result.stderr);
      }
    },

    async listCerts(app: string): Promise<string[]> {
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

    async removeCert(app: string, hostname: string): Promise<void> {
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

    async getFlyToken(): Promise<string> {
      // Read access_token from ~/.fly/config.yml
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

    async listAppsWithNetwork(org: string): Promise<FlyAppInfo[]> {
      const token = await this.getFlyToken();

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
  };
};

// =============================================================================
// App Naming
// =============================================================================

export const getRouterAppName = (
  network: string,
  randomSuffix: string,
): string => {
  return `${ROUTER_APP_PREFIX}${network}-${randomSuffix}`;
};

/** Extract the routerId suffix from a router app name. */
export const getRouterSuffix = (
  routerAppName: string,
  network: string,
): string => {
  const prefix = `${ROUTER_APP_PREFIX}${network}-`;
  return routerAppName.slice(prefix.length);
};

/** Build the physical Fly app name for a workload. */
export const getWorkloadAppName = (
  name: string,
  routerId: string,
): string => {
  return `${name}-${routerId}`;
};
