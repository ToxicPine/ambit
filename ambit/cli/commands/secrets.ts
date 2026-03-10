// =============================================================================
// Secrets Command - Manage Secrets for Workload Apps
// =============================================================================

import { parseArgs } from "@std/cli";
import { Table } from "@cliffy/table";
import { bold } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput, type Output } from "@/lib/output.ts";
import { registerCommand } from "@/cli/mod.ts";
import { findWorkloadApp } from "@/util/discovery.ts";
import { initSession } from "@/util/session.ts";
import type { FlyProvider } from "@/providers/fly.ts";

// =============================================================================
// Types
// =============================================================================

type SecretsListResult = {
  app: string;
  network: string;
  flyAppName: string;
  secrets: Array<{ name: string; digest: string }>;
};

type SecretsActionResult = {
  app: string;
  network: string;
  flyAppName: string;
};

// =============================================================================
// Shared Helpers
// =============================================================================

const resolveAppTarget = (
  out: Output<Record<string, unknown>>,
  appArg: string | number | undefined,
  command: string,
): { app: string; network: string } => {
  if (!appArg || typeof appArg !== "string") {
    return out.die(`Missing App Name. Usage: ${command} <app>.<network>`);
  }

  if (!appArg.includes(".")) {
    return out.die(`Missing Network. Use: ${command} ${appArg}.<network>`);
  }

  const parts = appArg.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return out.die(
      `'${appArg}' Should Have Exactly One Dot, Like my-app.my-network`,
    );
  }

  return { app: parts[0], network: parts[1] };
};

const resolveFlyAppName = async (
  out: Output<Record<string, unknown>>,
  fly: FlyProvider,
  org: string,
  app: string,
  network: string,
): Promise<string> => {
  const workload = await findWorkloadApp(fly, org, app, network);
  if (!workload) {
    return out.die(`App '${app}' Not Found on Network '${network}'`);
  }
  return workload.appName;
};

// =============================================================================
// Secrets List
// =============================================================================

const secretsList = async (argv: string[]): Promise<void> => {
  const opts = { string: ["org"], boolean: ["help", "json"] } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit secrets list", 1);

  if (args.help) {
    console.log(`
${bold("ambit secrets list")} - List Secrets for an App

${bold("USAGE")}
  ambit secrets list <app>.<network> [--org <org>] [--json]

${bold("OPTIONS")}
  --org <org>   Fly.io organization slug
  --json        Output as JSON

${bold("EXAMPLES")}
  ambit secrets list my-app.browsers
  ambit secrets list my-app.browsers --json
`);
    return;
  }

  const out = createOutput<SecretsListResult>(args.json);
  const { app, network } = resolveAppTarget(
    out,
    args._[0],
    "ambit secrets list",
  );

  const { fly, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  const flyAppName = await resolveFlyAppName(out, fly, org, app, network);
  const secrets = await fly.secrets.list(flyAppName);

  if (secrets.length === 0) {
    out.blank()
      .text(`No Secrets Found for ${app}.${network}.`)
      .blank();
  } else {
    out.blank().header(`Secrets for ${app}.${network}`).blank();

    const table = new Table()
      .header(["Name", "Digest"])
      .body(secrets.map((s) => [s.name, s.digest]))
      .indent(2)
      .padding(2);

    out.text(table.toString());
    out.blank();
  }

  out.done({ app, network, flyAppName, secrets });
  out.print();
};

// =============================================================================
// Secrets Set
// =============================================================================

const secretsSet = async (argv: string[]): Promise<void> => {
  const opts = {
    string: ["org", "env"],
    boolean: ["help", "json", "stage"],
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit secrets set", Infinity);

  if (args.help) {
    console.log(`
${bold("ambit secrets set")} - Set Secrets for an App

${bold("USAGE")}
  ambit secrets set <app>.<network> KEY=VALUE ... [--org <org>] [--stage] [--json]
  ambit secrets set <app>.<network> --env <file> [--org <org>] [--stage] [--json]

${bold("OPTIONS")}
  --env <file>  Load secrets from an env file (KEY=VALUE per line)
  --org <org>   Fly.io organization slug
  --stage       Stage secrets without deploying
  --json        Output as JSON

${bold("EXAMPLES")}
  ambit secrets set my-app.browsers API_KEY=abc123
  ambit secrets set my-app.browsers KEY1=val1 KEY2=val2 --stage
  ambit secrets set my-app.browsers --env .env
`);
    return;
  }

  const out = createOutput<SecretsActionResult>(args.json);
  const { app, network } = resolveAppTarget(
    out,
    args._[0],
    "ambit secrets set",
  );

  const secretsObj: Record<string, string> = {};

  // Load from env file if provided
  if (args.env) {
    let content: string;
    try {
      content = await Deno.readTextFile(args.env);
    } catch {
      return out.die(`Failed to Read Env File: ${args.env}`);
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      secretsObj[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }

  // Load from positional KEY=VALUE args
  const pairs = args._.slice(1).map(String);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      return out.die(`Invalid Format: '${pair}'. Expected KEY=VALUE`);
    }
    secretsObj[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  if (Object.keys(secretsObj).length === 0) {
    return out.die(
      "No Secrets Provided. Use KEY=VALUE args or --env <file>",
    );
  }

  const { fly, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  const flyAppName = await resolveFlyAppName(out, fly, org, app, network);

  await out.spin(
    args.stage ? "Staging Secrets" : "Setting Secrets",
    () => fly.secrets.set(flyAppName, secretsObj, { stage: args.stage }),
  );

  out.done({ app, network, flyAppName });
  out.print();
};

// =============================================================================
// Secrets Unset
// =============================================================================

const secretsUnset = async (argv: string[]): Promise<void> => {
  const opts = {
    string: ["org"],
    boolean: ["help", "json", "stage"],
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit secrets unset", Infinity);

  if (args.help) {
    console.log(`
${bold("ambit secrets unset")} - Remove Secrets from an App

${bold("USAGE")}
  ambit secrets unset <app>.<network> KEY ... [--org <org>] [--stage] [--json]

${bold("OPTIONS")}
  --org <org>   Fly.io organization slug
  --stage       Stage removal without deploying
  --json        Output as JSON

${bold("EXAMPLES")}
  ambit secrets unset my-app.browsers API_KEY
  ambit secrets unset my-app.browsers KEY1 KEY2 --stage
`);
    return;
  }

  const out = createOutput<SecretsActionResult>(args.json);
  const { app, network } = resolveAppTarget(
    out,
    args._[0],
    "ambit secrets unset",
  );

  const keys = args._.slice(1).map(String);
  if (keys.length === 0) {
    return out.die(
      "No Secret Names Provided. Usage: ambit secrets unset <app>.<network> KEY ...",
    );
  }

  const { fly, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  const flyAppName = await resolveFlyAppName(out, fly, org, app, network);

  await out.spin(
    args.stage ? "Staging Secrets Removal" : "Removing Secrets",
    () => fly.secrets.unset(flyAppName, keys, { stage: args.stage }),
  );

  out.done({ app, network, flyAppName });
  out.print();
};

// =============================================================================
// Secrets Deploy
// =============================================================================

const secretsDeploy = async (argv: string[]): Promise<void> => {
  const opts = { string: ["org"], boolean: ["help", "json"] } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit secrets deploy", 1);

  if (args.help) {
    console.log(`
${bold("ambit secrets deploy")} - Deploy Staged Secrets

${bold("USAGE")}
  ambit secrets deploy <app>.<network> [--org <org>] [--json]

${bold("OPTIONS")}
  --org <org>   Fly.io organization slug
  --json        Output as JSON

${bold("EXAMPLES")}
  ambit secrets deploy my-app.browsers
`);
    return;
  }

  const out = createOutput<SecretsActionResult>(args.json);
  const { app, network } = resolveAppTarget(
    out,
    args._[0],
    "ambit secrets deploy",
  );

  const { fly, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  const flyAppName = await resolveFlyAppName(out, fly, org, app, network);

  await out.spin(
    "Deploying Secrets",
    () => fly.secrets.deploy(flyAppName),
  );

  out.done({ app, network, flyAppName });
  out.print();
};

// =============================================================================
// Top-Level Help
// =============================================================================

const showSecretsHelp = (): void => {
  console.log(`
${bold("ambit secrets")} - Manage Secrets for Workload Apps

${bold("USAGE")}
  ambit secrets list <app>.<network> [options]
  ambit secrets set <app>.<network> KEY=VALUE ... [options]
  ambit secrets unset <app>.<network> KEY ... [options]
  ambit secrets deploy <app>.<network> [options]

${bold("SUBCOMMANDS")}
  list      List secret names and digests
  set       Set one or more secrets
  unset     Remove one or more secrets
  deploy    Deploy staged secrets

${bold("OPTIONS")}
  --org <org>   Fly.io organization slug
  --stage       Stage changes without deploying (set/unset only)
  --json        Output as JSON

${bold("EXAMPLES")}
  ambit secrets list my-app.browsers
  ambit secrets set my-app.browsers API_KEY=abc123
  ambit secrets unset my-app.browsers API_KEY
  ambit secrets deploy my-app.browsers

Run 'ambit secrets <subcommand> --help' for details.
`);
};

// =============================================================================
// Dispatcher
// =============================================================================

const secrets = async (argv: string[]): Promise<void> => {
  const subcommand = typeof argv[0] === "string" ? argv[0] : undefined;

  if (subcommand === "list" || subcommand === "ls") {
    return secretsList(argv.slice(1));
  }
  if (subcommand === "set") return secretsSet(argv.slice(1));
  if (subcommand === "unset") return secretsUnset(argv.slice(1));
  if (subcommand === "deploy") return secretsDeploy(argv.slice(1));

  const opts = { boolean: ["help"] } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit secrets", 0);

  if (args.help) {
    showSecretsHelp();
    return;
  }

  showSecretsHelp();
  Deno.exit(1);
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "secrets",
  description: "Manage secrets for workload apps",
  usage: "ambit secrets list|set|unset|deploy <app>.<network> [options]",
  run: secrets,
});
