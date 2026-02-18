// =============================================================================
// Destroy Command - Tear Down Router and Clean Up
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, confirm } from "../../../lib/cli.ts";
import { createOutput } from "../../../lib/output.ts";
import { registerCommand } from "../mod.ts";
import { createFlyProvider } from "../../providers/fly.ts";
import { requireTailscaleProvider } from "../../credentials.ts";
import { findRouterApp } from "../../discovery.ts";
import { resolveOrg } from "../../resolve.ts";

// =============================================================================
// Destroy Command
// =============================================================================

const destroy = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, {
    string: ["network", "org"],
    boolean: ["help", "yes", "json"],
    alias: { y: "yes" },
  });

  if (args.help) {
    console.log(`
${bold("ambit destroy")} - Tear Down Router

${bold("USAGE")}
  ambit destroy --network <name> [--org <org>] [--yes] [--json]

${bold("OPTIONS")}
  --network <name>   Network of the router to destroy (required)
  --org <org>        Fly.io organization slug
  -y, --yes          Skip confirmation prompts
  --json             Output as JSON
`);
    return;
  }

  const out = createOutput<{
    destroyed: boolean;
    appName: string;
  }>(args.json);

  if (!args.network) {
    return out.die("--network Is Required");
  }

  const fly = createFlyProvider();
  await fly.ensureInstalled();
  await fly.ensureAuth({ interactive: !args.json });
  const tailscale = await requireTailscaleProvider(out);

  const org = await resolveOrg(fly, args, out);

  // 1. Find the router app
  const spinner = out.spinner("Discovering Router");
  const app = await findRouterApp(fly, org, args.network);

  if (!app) {
    spinner.fail("Router Not Found");
    return out.die(`No Router Found for Network '${args.network}'`);
  }

  spinner.success(`Found Router: ${app.appName}`);

  // Get tailscale device to read the actual tag
  let tsDevice: Awaited<ReturnType<typeof tailscale.getDeviceByHostname>> = null;
  try {
    tsDevice = await tailscale.getDeviceByHostname(app.appName);
  } catch { /* device may not exist */ }
  const tag = tsDevice?.tags?.[0] ?? null;

  out.blank()
    .header("ambit Destroy")
    .blank()
    .text(`  Network:    ${app.network}`)
    .text(`  Router App: ${app.appName}`)
    .text(`  Tag:        ${tag ?? "unknown"}`)
    .blank();

  if (!args.yes && !args.json) {
    const confirmed = await confirm("Destroy this router?");
    if (!confirmed) {
      out.text("Cancelled.");
      return;
    }
    out.blank();
  }

  // 2. Clean up tailscale
  const dnsSpinner = out.spinner("Clearing Split DNS");
  try {
    await tailscale.clearSplitDns(app.network);
    dnsSpinner.success("Split DNS Cleared");
  } catch {
    dnsSpinner.fail("Split DNS Already Cleared");
  }

  const deviceSpinner = out.spinner("Removing Tailscale Device");
  try {
    const device = await tailscale.getDeviceByHostname(app.appName);
    if (device) {
      await tailscale.deleteDevice(device.id);
      deviceSpinner.success("Tailscale Device Removed");
    } else {
      deviceSpinner.success("Tailscale Device Not Found (Already Removed)");
    }
  } catch {
    deviceSpinner.fail("Could Not Remove Tailscale Device");
  }

  // 3. Destroy Fly app
  const appSpinner = out.spinner("Destroying Fly App");
  try {
    await fly.deleteApp(app.appName);
    appSpinner.success("Fly App Destroyed");
  } catch {
    appSpinner.fail("Could Not Destroy Fly App");
  }

  out.done({ destroyed: true, appName: app.appName });

  out.ok("Router Destroyed");

  if (tag) {
    out.blank()
      .dim("If you added ACL policy entries for this router, remember to remove:")
      .dim(`  tagOwners:     ${tag}`)
      .dim(`  autoApprovers: routes for ${tag}`)
      .dim(`  acls:          rules referencing ${tag}`)
      .blank();
  } else {
    out.blank()
      .dim("If you added ACL policy entries for this router, remember to remove")
      .dim("the associated tag from tagOwners, autoApprovers, and acls.")
      .blank();
  }

  out.print();
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "destroy",
  description: "Tear down the router, clean up DNS and tailnet device",
  usage: "ambit destroy --network <name> [--org <org>] [--yes] [--json]",
  run: destroy,
});
