// =============================================================================
// Deploy Command - Safely Deploy a Workload App on a Custom Private Network
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, confirm, fileExists } from "../../../lib/cli.ts";
import { createOutput } from "../../../lib/output.ts";
import { registerCommand } from "../mod.ts";
import { createFlyProvider } from "../../providers/fly.ts";
import { findRouterApp } from "../../discovery.ts";
import { resolveOrg } from "../../resolve.ts";
import { assertNotRouter, auditDeploy, scanFlyToml } from "../../guard.ts";

// =============================================================================
// Deploy Command
// =============================================================================

const deploy = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["network", "org", "region", "image", "config"],
    boolean: ["help", "yes", "json"],
    alias: { y: "yes" },
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
  --network <name>   Custom 6PN network to target (required)
  --org <org>        Fly.io organization slug
  --region <region>  Primary deployment region
  --image <img>      Docker image (mutually exclusive with --config)
  --config <path>    fly.toml path (mutually exclusive with --image)
  -y, --yes          Skip confirmation prompts
  --json             Output as JSON

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

  const app = args._[0] as string | undefined;
  if (!app) {
    return out.die(
      "App Name Required. Usage: ambit deploy <app> --network <name>",
    );
  }

  if (!args.network) {
    return out.die("--network Is Required");
  }

  try {
    assertNotRouter(app);
  } catch (e) {
    return out.die((e as Error).message);
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
  // Phase 4: Pre-flight TOML Scan
  // ==========================================================================

  out.header("Step 4: Pre-flight Check").blank();

  let preflight = { scanned: false, warnings: [] as string[] };

  // Determine config path for config mode (not image mode)
  let configPath: string | undefined = args.config;
  if (!args.image) {
    if (!configPath) {
      // Auto-detect ./fly.toml
      if (await fileExists("./fly.toml")) {
        configPath = "./fly.toml";
      }
    }

    if (configPath) {
      if (!(await fileExists(configPath))) {
        return out.die(`Config File Not Found: ${configPath}`);
      }

      const tomlContent = await Deno.readTextFile(configPath);
      const scan = scanFlyToml(tomlContent);
      preflight = { scanned: scan.scanned, warnings: scan.warnings };

      if (scan.errors.length > 0) {
        for (const err of scan.errors) {
          out.err(err);
        }
        return out.die(
          "Pre-flight Check Failed. Fix fly.toml Before Deploying.",
        );
      }

      for (const warn of scan.warnings) {
        out.warn(warn);
      }

      out.ok(`Scanned ${configPath}`);
    } else {
      out.info("No fly.toml Found — Deploying Without Config Scan");
    }
  } else {
    out.info("Image Mode — Skipping TOML Scan");
  }

  out.blank();

  // ==========================================================================
  // Phase 5: Deploy with Enforced Flags
  // ==========================================================================

  out.header("Step 5: Deploy").blank();
  out.dim("Deploying with --no-public-ips --flycast ...");

  await fly.deploySafe(app, {
    image: args.image,
    config: configPath,
    region: args.region,
  });

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
    out.warn(`Released ${audit.public_ips_released} public IP(s)`);
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

  if (hasIssues) {
    out.fail("Deploy Completed with Issues", {
      app,
      network,
      created,
      audit: {
        public_ips_released: audit.public_ips_released,
        flycast_allocations: audit.flycast_allocations,
        warnings: audit.warnings,
      },
      preflight,
    });
  } else {
    out.done({
      app,
      network,
      created,
      audit: {
        public_ips_released: audit.public_ips_released,
        flycast_allocations: audit.flycast_allocations,
        warnings: audit.warnings,
      },
      preflight,
    });
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
