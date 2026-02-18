// =============================================================================
// Setup Command - Discover Router and Save Network Preference
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, dim, prompt } from "@cardelli/ambit/lib/cli";
import { createOutput } from "@cardelli/ambit/lib/output";
import { registerCommand } from "../mod.ts";
import { loadConfig, saveConfig } from "../../schemas/config.ts";
import { createFlyProvider } from "@cardelli/ambit/providers/fly";
import { listRouterApps, type RouterApp } from "@cardelli/ambit/src/discovery";
import { resolveOrg } from "@cardelli/ambit/src/resolve";

// =============================================================================
// Setup Command
// =============================================================================

const setup = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["network", "org"],
    boolean: ["help", "yes", "json"],
    alias: { y: "yes" },
  });

  if (args.help) {
    console.log(`
${bold("chromatic setup")} - Discover Router and Save Network Preference

${bold("USAGE")}
  chromatic setup [options]

${bold("OPTIONS")}
  --network <name>    Network to use (default: auto-detect or "browsers")
  --org <org>         Fly.io organization slug
  -y, --yes           Skip confirmation prompts
  --json              Output as JSON

${bold("DESCRIPTION")}
  Discovers ambit subnet routers and saves your network preference.
  The router must already be deployed via 'ambit deploy'.

${bold("EXAMPLES")}
  chromatic setup
  chromatic setup --network custom-net --org my-org
  chromatic setup --org my-org --json
`);
    return;
  }

  const out = createOutput<{
    network: string;
    router: { appName: string };
  }>(args.json);

  out.blank()
    .header("=".repeat(50))
    .header("  Chromatic Setup")
    .header("=".repeat(50))
    .blank();

  // Authenticate with Fly.io
  const fly = createFlyProvider();
  await fly.ensureInstalled();

  const email = await fly.ensureAuth({ interactive: !args.json });
  out.ok(`Authenticated as ${email}`);

  const org = await resolveOrg(fly, args, out);

  // Find router apps (lightweight — just Fly REST API, no machine/tailscale calls)
  const spinner = out.spinner("Discovering Routers");
  const routerApps = await listRouterApps(fly, org);
  spinner.success(
    `Found ${routerApps.length} Router${routerApps.length !== 1 ? "s" : ""}`,
  );

  if (routerApps.length === 0) {
    return out.die(
      "No Router Found. Deploy One With: ambit deploy --network browsers",
    );
  }

  // Select network
  let selected: RouterApp;

  if (args.network) {
    const match = routerApps.find((r) => r.network === args.network);
    if (!match) {
      return out.die(`No Router Found on Network '${args.network}'`);
    }
    selected = match;
  } else if (routerApps.length === 1) {
    selected = routerApps[0];
    out.ok(`Using Network: ${selected.network}`);
  } else {
    if (args.json) {
      return out.die("Multiple Routers Found. Use --network to Select One");
    }

    out.blank().text("Available Networks:");
    for (const r of routerApps) {
      out.text(`  ${r.network} (${r.appName})`);
    }
    out.blank();

    const choice = await prompt("Network: ");
    const match = routerApps.find((r) => r.network === choice);
    if (!match) {
      return out.die(`Invalid Network: ${choice}`);
    }
    selected = match;
  }

  // Save minimal config
  const existingConfig = await loadConfig();
  await saveConfig({
    network: selected.network,
    defaults: existingConfig.defaults,
  });

  out.done({
    network: selected.network,
    router: { appName: selected.appName },
  });

  out.ok("Configuration Saved")
    .blank()
    .header("=".repeat(50))
    .header("  Setup Complete!")
    .header("=".repeat(50))
    .blank()
    .text("Chromatic Is Ready.")
    .blank()
    .dim("  chromatic create my-browser")
    .blank();

  out.print();
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "setup",
  description: "Discover routers and save network preference",
  usage: "chromatic setup [--network <name>] [--org <org>] [--yes] [--json]",
  run: setup,
});
