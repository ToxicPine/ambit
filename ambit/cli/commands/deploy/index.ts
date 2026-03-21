// =============================================================================
// Deploy Command - Safely Deploy a Workload App on a Custom Private Network
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput, type Output } from "@/lib/output.ts";
import { type Machine, runMachine } from "@/lib/machine.ts";
import { registerCommand } from "@/cli/mod.ts";
import { createFlyProvider, type FlyProvider } from "@/providers/fly.ts";
import { getWorkloadAppName } from "@/util/naming.ts";
import { findRouterApp, getRouterMachineInfo } from "@/util/discovery.ts";
import { resolveOrg } from "@/util/resolve.ts";
import { assertNotRouter } from "@/util/guard.ts";
import {
  type DeployConfig,
  resolveConfigMode,
  resolveImageMode,
  resolveTemplateMode,
} from "./modes.ts";
import {
  type DeployCtx,
  type DeployPhase,
  type DeployResult,
  deployTransition,
  hydrateDeploy,
  reportDeploySkipped,
} from "./machine.ts";

// =============================================================================
// Stage 1: Fly.io Configuration
// =============================================================================

const stageFlyConfig = async (
  out: Output<DeployResult>,
  opts: { json: boolean; org?: string },
): Promise<{ fly: FlyProvider; org: string }> => {
  out.header("Step 1: Fly.io Configuration").blank();

  const fly = createFlyProvider();
  await fly.auth.ensureInstalled();

  const email = await fly.auth.login({ interactive: !opts.json });
  out.ok(`Authenticated as ${email}`);

  const org = await resolveOrg(fly, opts, out);
  out.blank();

  return { fly, org };
};

// =============================================================================
// Stage 2: Network Verification
// =============================================================================

const stageNetworkVerification = async (
  out: Output<DeployResult>,
  fly: FlyProvider,
  opts: { org: string; network: string; app: string },
): Promise<
  { routerId: string; flyAppName: string; routerPrivateIp?: string }
> => {
  out.header("Step 2: Network Verification").blank();

  const routerSpinner = out.spinner("Checking for Router on Network");
  const router = await findRouterApp(fly, opts.org, opts.network);

  if (!router) {
    routerSpinner.fail("No Router Found");
    return out.die(
      `No Ambit Router Found on Network '${opts.network}'. ` +
        `Run 'ambit create ${opts.network}' First.`,
    );
  }

  routerSpinner.success(`Router Found: ${router.appName}`);

  const routerMachine = await getRouterMachineInfo(fly, router.appName);
  out.blank();

  return {
    routerId: router.routerId,
    flyAppName: getWorkloadAppName(opts.app, router.routerId),
    routerPrivateIp: routerMachine?.privateIp,
  };
};

// =============================================================================
// Stage 3: Pre-flight Check
// =============================================================================

const stagePreflightCheck = async (
  out: Output<DeployResult>,
  opts: {
    template?: string;
    image?: string;
    config?: string;
    mainPort: string;
  },
): Promise<DeployConfig> => {
  out.header("Step 3: Pre-flight Check").blank();

  let deployConfig: DeployConfig | null;

  if (opts.template) {
    deployConfig = await resolveTemplateMode(opts.template, out);
  } else if (opts.image) {
    deployConfig = resolveImageMode(opts.image, opts.mainPort, out);
  } else {
    deployConfig = await resolveConfigMode(opts.config, out);
  }

  if (!deployConfig) return out.die("Pre-flight Check Failed");

  out.blank();
  return deployConfig;
};

// =============================================================================
// Stage 4: Deploy
// =============================================================================

const stageDeploy = async (
  out: Output<DeployResult>,
  fly: FlyProvider,
  deployConfig: DeployConfig,
  opts: {
    app: string;
    network: string;
    org: string;
    region?: string;
    yes: boolean;
    json: boolean;
    routerId: string;
    flyAppName: string;
    routerPrivateIp?: string;
    // VM sizing
    vmSize?: string;
    vmCpus?: number;
    vmMemory?: string;
    vmCpuKind?: string;
    vmGpuKind?: string;
    vmGpus?: number;
    // Build options
    dockerfile?: string;
    buildArg?: string[];
    buildSecret?: string[];
    buildTarget?: string;
    localOnly?: boolean;
    remoteOnly?: boolean;
    // Deploy behavior
    env?: string[];
    strategy?: string;
    detach?: boolean;
    waitTimeout?: string;
    volumeInitialSize?: number;
  },
): Promise<void> => {
  out.header("Step 4: Deploy").blank();

  const ctx: DeployCtx = {
    fly,
    out,
    ...opts,
    created: false,
    deployConfig,
    deployOptions: {
      routerId: opts.routerId,
      image: deployConfig.image,
      config: deployConfig.configPath,
      region: opts.region,
      // VM sizing
      vmSize: opts.vmSize,
      vmCpus: opts.vmCpus,
      vmMemory: opts.vmMemory,
      vmCpuKind: opts.vmCpuKind,
      vmGpuKind: opts.vmGpuKind,
      vmGpus: opts.vmGpus,
      // Build options
      dockerfile: opts.dockerfile,
      buildArg: opts.buildArg,
      buildSecret: opts.buildSecret,
      buildTarget: opts.buildTarget,
      localOnly: opts.localOnly,
      remoteOnly: opts.remoteOnly,
      // Deploy behavior
      env: opts.env,
      strategy: opts.strategy,
      detach: opts.detach,
      waitTimeout: opts.waitTimeout,
      volumeInitialSize: opts.volumeInitialSize,
    },
  };

  const phase = await hydrateDeploy(ctx);
  reportDeploySkipped(out, phase);

  const machine: Machine<DeployPhase, DeployCtx> = {
    terminal: "complete",
    transition: deployTransition,
  };

  const result = await runMachine(machine, phase, ctx);

  if (!result.ok) {
    if (result.error === "Cancelled") return;
    return out.die(result.error!);
  }

  stageSummary(out, ctx, deployConfig);
};

// =============================================================================
// Stage 5: Summary
// =============================================================================

const stageSummary = (
  out: Output<DeployResult>,
  ctx: DeployCtx,
  deployConfig: DeployConfig,
): void => {
  const audit = ctx.audit ?? {
    public_ips_released: 0,
    certs_removed: 0,
    flycast_allocations: [],
    warnings: [],
  };

  const hasIssues = audit.public_ips_released > 0 || audit.warnings.length > 0;

  const resultData: DeployResult = {
    app: ctx.app,
    network: ctx.network,
    created: ctx.created,
    audit,
    preflight: deployConfig.preflight,
  };

  if (hasIssues) {
    out.fail("Deploy Completed with Issues", resultData);
  } else {
    out.done(resultData);
  }

  out.blank()
    .header("=".repeat(50))
    .header(
      hasIssues ? "  Deploy Completed (with Warnings)" : "  Deploy Completed!",
    )
    .header("=".repeat(50))
    .blank()
    .text(`App '${ctx.app}' Is Reachable from Your Tailnet as:`)
    .text(`  ${ctx.app}.${ctx.network}`)
    .blank();

  out.print();
};

// =============================================================================
// Deploy Command
// =============================================================================

const deploy = async (argv: string[]): Promise<void> => {
  const opts = {
    string: [
      "network",
      "org",
      "region",
      "image",
      "config",
      "main-port",
      "template",
      // VM sizing
      "vm-size",
      "vm-cpus",
      "vm-memory",
      "vm-cpu-kind",
      "vm-gpu-kind",
      "vm-gpus",
      // Build options
      "dockerfile",
      "build-target",
      "strategy",
      "wait-timeout",
      "volume-initial-size",
    ],
    boolean: ["help", "yes", "json", "local-only", "remote-only", "detach"],
    alias: { y: "yes", e: "env" },
    default: { "main-port": "80" },
    collect: ["build-arg", "build-secret", "env"],
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit deploy", 1);

  if (args.help) {
    console.log(`
${bold("ambit deploy")} - Deploy an App Safely on a Custom Private Network

${bold("USAGE")}
  ambit deploy <app>.<network> [options]
  ambit deploy <app> --network <name> [options]

  The network can be specified as part of the name (app.network) or with --network.

${bold("MODES")}
  Config mode (default):
    ambit deploy my-app.lab                                Uses ./fly.toml
    ambit deploy my-app.lab --config path                  Explicit fly.toml

  Image mode:
    ambit deploy my-app.lab --image <img>                  Docker image, no toml

  Template mode:
    ambit deploy my-app.lab --template <ref>               GitHub template

${bold("OPTIONS")}
  --network <name>       Target network
  --org <org>            Fly.io organization slug
  --region <region>      Primary deployment region
  -y, --yes              Skip confirmation prompts
  --json                 Output as JSON

${bold("CONFIG MODE")} (default)
  --config <path>        Explicit fly.toml path (auto-detects ./fly.toml if omitted)

${bold("IMAGE MODE")}
  --image <img>          Docker image to deploy (no fly.toml needed)
  --main-port <port>     Internal port for HTTP service (default: 80, "none" to skip)

${bold("TEMPLATE MODE")}
  --template <ref>       GitHub template as owner/repo[/path][@ref]

  Reference format:
    owner/repo                Fetch repo root from the default branch
    owner/repo/path           Fetch subdirectory from the default branch
    owner/repo/path@tag       Fetch a tagged release
    owner/repo/path@branch    Fetch a specific branch
    owner/repo/path@commit    Fetch a specific commit

${bold("VM SIZING")}
  --vm-size <size>       VM size preset (see "fly platform vm-sizes")
  --vm-cpus <n>          Number of CPUs
  --vm-memory <mb>       Memory in megabytes
  --vm-cpu-kind <kind>   CPU kind: "shared" or "performance"
  --vm-gpu-kind <model>  GPU model (a100-pcie-40gb, a100-sxm4-80gb, l40s, a10)
  --vm-gpus <n>          Number of GPUs

${bold("BUILD OPTIONS")} (config/template mode only)
  --dockerfile <path>    Path to Dockerfile
  --build-arg <K=V>      Build-time variable (repeatable)
  --build-secret <K=V>   Build-time secret (repeatable)
  --build-target <stage> Target build stage for multi-stage Dockerfiles
  --local-only           Build locally using local Docker daemon
  --remote-only          Build on remote builder (default)

${bold("DEPLOY BEHAVIOR")}
  -e, --env <K=V>        Environment variable (repeatable)
  --strategy <name>      Deploy strategy: canary, rolling, bluegreen, immediate
  --detach               Return immediately without monitoring
  --wait-timeout <dur>   Time to wait for machines to become healthy (default: 5m0s)
  --volume-initial-size <gb>  Initial volume size in GB on first deploy

${bold("SAFETY")}
  Always deploys with --no-public-ips and --flycast.
  Post-deploy audit releases any public IPs and verifies Flycast allocation.
  Pre-flight scan rejects fly.toml with force_https or TLS on 443.

${bold("EXAMPLES")}
  ambit deploy my-app.lab
  ambit deploy my-app.lab --image registry/img:latest
  ambit deploy my-app.lab --config ./fly.toml --region sea
  ambit deploy my-claw.lab --template ToxicPine/ambit-openclaw
  ambit deploy my-browser.lab --template ToxicPine/ambit-templates/chromatic
  ambit deploy my-browser --network lab --template ToxicPine/ambit-templates/chromatic@v1.0
`);
    return;
  }

  const out = createOutput<DeployResult>(args.json);

  const appArg = args._[0];
  if (!appArg || typeof appArg !== "string") {
    return out.die("Missing App Name. Usage: ambit deploy <app>.<network>");
  }

  let app: string;
  let network: string;

  if (appArg.includes(".")) {
    const parts = appArg.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return out.die(
        `'${appArg}' Should Have Exactly One Dot, Like my-app.my-network`,
      );
    }
    if (args.network) {
      return out.die(
        `Network Is Already Part of the Name ('${appArg}'), --network Is Not Needed`,
      );
    }
    app = parts[0];
    network = parts[1];
  } else {
    app = appArg;
    if (!args.network) {
      return out.die(`Missing Network. Use: ambit deploy ${app}.<network>`);
    }
    network = args.network;
  }

  try {
    assertNotRouter(app);
  } catch (e) {
    return out.die(e instanceof Error ? e.message : String(e));
  }

  const modeFlags = [args.image, args.config, args.template].filter(Boolean);
  if (modeFlags.length > 1) {
    return out.die("--image, --config, and --template Are Mutually Exclusive");
  }

  out.blank()
    .header("=".repeat(50))
    .header(`  ambit Deploy: ${app}`)
    .header("=".repeat(50))
    .blank();

  const { fly, org } = await stageFlyConfig(out, {
    json: args.json,
    org: args.org,
  });

  const { routerId, flyAppName, routerPrivateIp } =
    await stageNetworkVerification(out, fly, { org, network, app });

  const deployConfig = await stagePreflightCheck(out, {
    template: args.template,
    image: args.image,
    config: args.config,
    mainPort: String(args["main-port"]),
  });

  await stageDeploy(out, fly, deployConfig, {
    app,
    network,
    org,
    region: args.region,
    yes: args.yes,
    json: args.json,
    routerId,
    flyAppName,
    routerPrivateIp,
    // VM sizing
    vmSize: args["vm-size"],
    vmCpus: args["vm-cpus"] ? Number(args["vm-cpus"]) : undefined,
    vmMemory: args["vm-memory"],
    vmCpuKind: args["vm-cpu-kind"],
    vmGpuKind: args["vm-gpu-kind"],
    vmGpus: args["vm-gpus"] ? Number(args["vm-gpus"]) : undefined,
    // Build options
    dockerfile: args.dockerfile,
    buildArg: args["build-arg"] as string[] | undefined,
    buildSecret: args["build-secret"] as string[] | undefined,
    buildTarget: args["build-target"],
    localOnly: args["local-only"],
    remoteOnly: args["remote-only"],
    // Deploy behavior
    env: args.env as string[] | undefined,
    strategy: args.strategy,
    detach: args.detach,
    waitTimeout: args["wait-timeout"],
    volumeInitialSize: args["volume-initial-size"]
      ? Number(args["volume-initial-size"])
      : undefined,
  });
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "deploy",
  description: "Deploy an app safely on a custom private network",
  usage:
    "ambit deploy <app> --network <name> [--image <img>] [--template <ref>] [--org <org>] [--region <region>]",
  run: deploy,
});
