// =============================================================================
// Destroy Command - Remove a Browser or Pool
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, confirm, red, Spinner } from "@cardelli/ambit/lib/cli";
import { createOutput } from "@cardelli/ambit/lib/output";
import { resolveOrg } from "@cardelli/ambit/src/resolve";
import { registerCommand } from "../mod.ts";
import { loadConfig } from "../../schemas/config.ts";
import { findCdpApp, getInstanceStateSummary } from "../../schemas/instance.ts";
import { createFlyProvider } from "@cardelli/ambit/providers/fly";

// =============================================================================
// Destroy Command
// =============================================================================

const destroy = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["network", "org"],
    boolean: ["help", "force", "yes", "json"],
    alias: { f: "force", y: "yes" },
  });

  if (args.help) {
    console.log(`
${bold("chromatic destroy")} - Remove a Browser or Pool

${bold("USAGE")}
  chromatic destroy <name> [options]

${bold("OPTIONS")}
  -f, --force       Destroy without confirmation
  -y, --yes         Same as --force
  --network <name>  Network name (default: from config)
  --org <org>       Fly.io organization slug
  --json            Output as JSON

${bold("EXAMPLES")}
  chromatic destroy my-browser
  chromatic destroy scrapers --force
  chromatic destroy scrapers --yes --json
`);
    return;
  }

  const out = createOutput<Record<string, unknown>>(args.json);

  const name = args._[0] as string | undefined;
  if (!name) {
    return out.die("Instance Name Required");
  }

  const config = await loadConfig();
  const network = args.network ?? config.network;

  const fly = createFlyProvider();
  await fly.ensureInstalled();
  await fly.ensureAuth({ interactive: !args.json });

  const org = await resolveOrg(fly, args, out);

  const app = await findCdpApp(fly, org, network, name);
  if (!app) {
    return out.die(`Instance '${name}' Not Found`);
  }

  const machines = await fly.listMachinesMapped(app.flyAppName);
  const summary = getInstanceStateSummary({
    name,
    flyAppName: app.flyAppName,
    machines: machines.map((m) => ({
      id: m.id,
      state: m.state as "creating" | "running" | "frozen" | "failed",
      size: m.size as "shared-cpu-1x" | "shared-cpu-2x" | "shared-cpu-4x",
      region: m.region,
      privateIp: m.privateIp,
    })),
  });

  out.blank()
    .header(`Instance: ${name}`)
    .text(`App:      ${app.flyAppName}`)
    .text(`Machines: ${summary.total}`)
    .blank();

  if (!args.force && !args.yes && !out.isJson()) {
    out.text(red("This Will Permanently Delete the Instance and All Machines"));
    out.blank();

    const shouldProceed = await confirm("Destroy This Instance?");
    if (!shouldProceed) {
      out.text("Cancelled.");
      out.print();
      return;
    }
    out.blank();
  }

  const spinner = new Spinner();
  if (!out.isJson()) spinner.start(`Destroying ${name}`);
  await fly.deleteApp(app.flyAppName);
  if (!out.isJson()) spinner.success(`Destroyed ${name}`);

  out.blank().ok("Instance Destroyed");
  out.done({
    destroyed: true,
    name,
    flyAppName: app.flyAppName,
    machinesDestroyed: summary.total,
  });
  out.print();
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "destroy",
  description: "Delete a browser or pool and all its machines",
  usage:
    "chromatic destroy <name> [--force] [--network NAME] [--org ORG] [--json]",
  run: destroy,
});
