// =============================================================================
// Deploy Command - Safely Deploy a Workload App on a Custom Private Network
// =============================================================================

import { parseArgs } from "@std/cli";
import { join } from "@std/path";
import { bold, confirm, fileExists } from "../../../lib/cli.ts";
import { createOutput } from "../../../lib/output.ts";
import { registerCommand } from "../mod.ts";
import { createFlyProvider, FlyDeployError } from "../../providers/fly.ts";
import { findRouterApp } from "../../discovery.ts";
import { resolveOrg } from "../../resolve.ts";
import { assertNotRouter, auditDeploy, scanFlyToml } from "../../guard.ts";

// =============================================================================
// Types
// =============================================================================

/** Resolved deploy configuration — the output of mode-specific validation. */
interface DeployConfig {
  image?: string;
  configPath?: string;
  preflight: { scanned: boolean; warnings: string[] };
  tempDir?: string;
}

// =============================================================================
// Image Mode
// =============================================================================

/**
 * Generate a minimal fly.toml with http_service config for auto start/stop.
 * Written to a temp directory and cleaned up after deploy.
 */
const generateServiceToml = (port: number): string =>
  `[http_service]\n` +
  `  internal_port = ${port}\n` +
  `  auto_stop_machines = "stop"\n` +
  `  auto_start_machines = true\n` +
  `  min_machines_running = 0\n`;

/**
 * Parse --main-port value. Returns the port number, or null if "none".
 * Dies on invalid input.
 */
const parseMainPort = (
  raw: string,
  out: ReturnType<typeof createOutput>,
): number | null | "error" => {
  if (raw === "none") return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    out.die(
      `Invalid --main-port: "${raw}". Use a port number (1-65535) or "none".`,
    );
    return "error";
  }
  return port;
};

/** Resolve deploy config for image mode (--image). */
const resolveImageMode = (
  image: string,
  mainPortRaw: string,
  out: ReturnType<typeof createOutput>,
): DeployConfig | null => {
  const mainPort = parseMainPort(mainPortRaw, out);
  if (mainPort === "error") return null;

  const preflight: DeployConfig["preflight"] = { scanned: false, warnings: [] };

  if (mainPort !== null) {
    const tempDir = Deno.makeTempDirSync();
    const configPath = join(tempDir, "fly.toml");
    Deno.writeTextFileSync(configPath, generateServiceToml(mainPort));
    out.ok(`HTTP Service on Port ${mainPort} (auto start/stop)`);
    return { image, configPath, preflight, tempDir };
  }

  out.info("Image Mode — No Service Config");
  return { image, preflight };
};

// =============================================================================
// Config Mode
// =============================================================================

/** Resolve deploy config for config mode (default — uses fly.toml). */
const resolveConfigMode = async (
  explicitConfig: string | undefined,
  out: ReturnType<typeof createOutput>,
): Promise<DeployConfig | null> => {
  // Determine config path: explicit --config, or auto-detect ./fly.toml
  let configPath = explicitConfig;
  if (!configPath && await fileExists("./fly.toml")) {
    configPath = "./fly.toml";
  }

  if (!configPath) {
    out.info("No fly.toml Found — Deploying Without Config Scan");
    return { preflight: { scanned: false, warnings: [] } };
  }

  if (!(await fileExists(configPath))) {
    out.die(`Config File Not Found: ${configPath}`);
    return null;
  }

  // Pre-flight scan
  const tomlContent = await Deno.readTextFile(configPath);
  const scan = scanFlyToml(tomlContent);

  if (scan.errors.length > 0) {
    for (const err of scan.errors) {
      out.err(err);
    }
    out.die("Pre-flight Check Failed. Fix fly.toml Before Deploying.");
    return null;
  }

  for (const warn of scan.warnings) {
    out.warn(warn);
  }

  out.ok(`Scanned ${configPath}`);

  return {
    configPath,
    preflight: { scanned: scan.scanned, warnings: scan.warnings },
  };
};

// =============================================================================
// Deploy Command
// =============================================================================

const deploy = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["network", "org", "region", "image", "config", "main-port"],
    boolean: ["help", "yes", "json"],
    alias: { y: "yes" },
    default: { "main-port": "80" },
  });

  if (args.help) {
    console.log(`
${bold("ambit deploy")} - Deploy an App Safely on a Custom Private Network

${bold("USAGE")}
  ambit deploy <app> --network <name> [options]

${bold("MODES")}
  Config mode (default):
    ambit deploy <app> --network <name>                 Uses ./fly.toml
    ambit deploy <app> --network <name> --config path   Explicit fly.toml

  Image mode:
    ambit deploy <app> --network <name> --image <img>   Docker image, no toml

${bold("OPTIONS")}
  --network <name>       Custom 6PN network to target (required)
  --org <org>            Fly.io organization slug
  --region <region>      Primary deployment region
  --image <img>          Docker image (mutually exclusive with --config)
  --config <path>        fly.toml path (mutually exclusive with --image)
  --main-port <port>     Internal port for HTTP service in image mode (default: 80, "none" to skip)
  -y, --yes              Skip confirmation prompts
  --json                 Output as JSON

${bold("SAFETY")}
  Always deploys with --no-public-ips and --flycast.
  Post-deploy audit releases any public IPs and verifies Flycast allocation.
  Pre-flight scan rejects fly.toml with force_https or TLS on 443.

${bold("EXAMPLES")}
  ambit deploy my-app --network browsers
  ambit deploy my-app --network browsers --image registry/img:latest
  ambit deploy my-app --network browsers --config ./fly.toml --region sea
`);
    return;
  }

  const out = createOutput<{
    app: string;
    network: string;
    created: boolean;
    audit: {
      public_ips_released: number;
      certs_removed: number;
      flycast_allocations: Array<{ address: string; network: string }>;
      warnings: string[];
    };
    preflight: {
      scanned: boolean;
      warnings: string[];
    };
  }>(args.json);

  // ==========================================================================
  // Phase 0: Parse & Validate
  // ==========================================================================

  const appArg = args._[0];
  if (!appArg || typeof appArg !== "string") {
    return out.die(
      "App Name Required. Usage: ambit deploy <app> --network <name>",
    );
  }
  const app = appArg;

  if (!args.network) {
    return out.die("--network Is Required");
  }

  try {
    assertNotRouter(app);
  } catch (e) {
    return out.die(e instanceof Error ? e.message : String(e));
  }

  if (args.image && args.config) {
    return out.die("--image and --config Are Mutually Exclusive");
  }

  const network = args.network;

  out.blank()
    .header("=".repeat(50))
    .header(`  ambit Deploy: ${app}`)
    .header("=".repeat(50))
    .blank();

  // ==========================================================================
  // Phase 1: Auth & Org
  // ==========================================================================

  out.header("Step 1: Fly.io Configuration").blank();

  const fly = createFlyProvider();
  await fly.ensureInstalled();

  const email = await fly.ensureAuth({ interactive: !args.json });
  out.ok(`Authenticated as ${email}`);

  const org = await resolveOrg(fly, args, out);
  out.blank();

  // ==========================================================================
  // Phase 2: Network Verification
  // ==========================================================================

  out.header("Step 2: Network Verification").blank();

  const routerSpinner = out.spinner("Checking for Router on Network");
  const router = await findRouterApp(fly, org, network);

  if (!router) {
    routerSpinner.fail("No Router Found");
    return out.die(
      `No ambit router found on network '${network}'. ` +
        `Run 'ambit create ${network}' first.`,
    );
  }

  routerSpinner.success(`Router Found: ${router.appName}`);
  out.blank();

  // ==========================================================================
  // Phase 3: App Creation (if needed)
  // ==========================================================================

  out.header("Step 3: App Setup").blank();

  let created = false;
  const exists = await fly.appExists(app);

  if (exists) {
    out.ok(`App '${app}' Exists`);
  } else {
    out.info(
      `App '${app}' Does Not Exist — Will Create on Network '${network}'`,
    );

    if (!args.yes && !args.json) {
      const confirmed = await confirm(
        `Create app '${app}' on network '${network}'?`,
      );
      if (!confirmed) {
        out.text("Cancelled.");
        return;
      }
    }

    await fly.createApp(app, org, { network });
    out.ok(`Created App '${app}' on Network '${network}'`);
    created = true;
  }

  out.blank();

  // ==========================================================================
  // Phase 4: Resolve Deploy Mode
  // ==========================================================================

  out.header("Step 4: Pre-flight Check").blank();

  const deployConfig = args.image
    ? resolveImageMode(args.image, String(args["main-port"]), out)
    : await resolveConfigMode(args.config, out);

  if (!deployConfig) return; // mode resolver already called out.die()

  out.blank();

  // ==========================================================================
  // Phase 5: Deploy with Enforced Flags
  // ==========================================================================

  out.header("Step 5: Deploy").blank();
  out.dim("Deploying with --no-public-ips --flycast ...");

  try {
    await fly.deploySafe(app, {
      image: deployConfig.image,
      config: deployConfig.configPath,
      region: args.region,
    });
  } catch (e) {
    if (e instanceof FlyDeployError) {
      out.dim(`  ${e.detail}`);
      return out.die(e.message);
    }
    throw e;
  } finally {
    if (deployConfig.tempDir) {
      try {
        Deno.removeSync(deployConfig.tempDir, { recursive: true });
      } catch { /* ignore */ }
    }
  }

  out.ok("Deploy Succeeded");
  out.blank();

  // ==========================================================================
  // Phase 6: Post-flight Audit
  // ==========================================================================

  out.header("Step 6: Post-flight Audit").blank();

  const auditSpinner = out.spinner("Auditing Deployment");
  const audit = await auditDeploy(fly, app, network);
  auditSpinner.success("Audit Complete");

  if (audit.public_ips_released > 0) {
    out.warn(`Released ${audit.public_ips_released} Public IP(s)`);
  }

  if (audit.certs_removed > 0) {
    out.ok(`Removed ${audit.certs_removed} Public Certificate(s)`);
  }

  for (const alloc of audit.flycast_allocations) {
    out.ok(`Flycast: ${alloc.address} (network: ${alloc.network})`);
  }

  for (const warn of audit.warnings) {
    out.warn(warn);
  }

  // ==========================================================================
  // Phase 7: Result
  // ==========================================================================

  const hasIssues = audit.public_ips_released > 0 || audit.warnings.length > 0;

  const result = {
    app,
    network,
    created,
    audit: {
      public_ips_released: audit.public_ips_released,
      certs_removed: audit.certs_removed,
      flycast_allocations: audit.flycast_allocations,
      warnings: audit.warnings,
    },
    preflight: deployConfig.preflight,
  };

  if (hasIssues) {
    out.fail("Deploy Completed with Issues", result);
  } else {
    out.done(result);
  }

  out.blank()
    .header("=".repeat(50))
    .header(
      hasIssues ? "  Deploy Completed (with warnings)" : "  Deploy Completed!",
    )
    .header("=".repeat(50))
    .blank()
    .text(`App '${app}' Is Reachable from Your Tailnet as:`)
    .text(`  ${app}.${network}`)
    .blank();

  out.print();
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "deploy",
  description: "Deploy an app safely on a custom private network",
  usage:
    "ambit deploy <app> --network <name> [--image <img>] [--org <org>] [--region <region>]",
  run: deploy,
});
