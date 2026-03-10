// =============================================================================
// Logs Command - Stream Logs for Workload Apps
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput } from "@/lib/output.ts";
import { streamCommand } from "@/lib/command.ts";
import { registerCommand } from "@/cli/mod.ts";
import { findWorkloadApp } from "@/util/discovery.ts";
import { initSession } from "@/util/session.ts";
import { StreamTable } from "@/lib/table.ts";

// =============================================================================
// Log Table
// =============================================================================

const logTable = new StreamTable([
  { name: "Timestamp", width: 19 },
  { name: "Region", width: 6 },
  { name: "Level", width: 5 },
  { name: "Message", width: 0 },
]);

const formatTimestamp = (ts: string): string => {
  return ts.replace("T", " ").replace(/\.\d+Z$/, "");
};

// =============================================================================
// Logs Command
// =============================================================================

const logs = async (argv: string[]): Promise<void> => {
  const opts = {
    string: ["org", "region", "machine"],
    boolean: ["help", "json", "no-tail"],
    alias: { r: "region", n: "no-tail" },
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit logs", 1);

  if (args.help) {
    console.log(`
${bold("ambit logs")} - Stream Logs for a Workload App

${bold("USAGE")}
  ambit logs <app>.<network> [options]

${bold("OPTIONS")}
  --org <org>        Fly.io organization slug
  -r, --region <r>   Filter by region
  --machine <id>     Filter by machine ID
  -n, --no-tail      Only fetch buffered logs (no streaming)
  --json             JSON output

${bold("EXAMPLES")}
  ambit logs my-app.browsers
  ambit logs my-app.browsers | less +F -R
  ambit logs my-app.browsers --no-tail | less -R
  ambit logs my-app.browsers --region iad --json
`);
    return;
  }

  const out = createOutput<Record<string, unknown>>(args.json);

  const appArg = args._[0];
  if (!appArg || typeof appArg !== "string") {
    return out.die("Missing App Name. Usage: ambit logs <app>.<network>");
  }

  if (!appArg.includes(".")) {
    return out.die(`Missing Network. Use: ambit logs ${appArg}.<network>`);
  }

  const parts = appArg.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return out.die(
      `'${appArg}' Should Have Exactly One Dot, Like my-app.my-network`,
    );
  }
  const app = parts[0];
  const network = parts[1];

  const { fly, org } = await initSession(out, {
    json: args.json,
    org: args.org,
  });

  const workload = await findWorkloadApp(fly, org, app, network);
  if (!workload) {
    return out.die(`App '${app}' Not Found on Network '${network}'`);
  }

  // Always request JSON from fly so we can parse and format
  const flyArgs = ["fly", "logs", "-a", workload.appName, "--json"];
  if (args["no-tail"]) flyArgs.push("--no-tail");
  if (args.region) flyArgs.push("--region", args.region);
  if (args.machine) flyArgs.push("--machine", args.machine);

  const stream = streamCommand(flyArgs);

  out.blank();
  out.text(logTable.header());
  out.text(logTable.separator());

  // fly logs --json emits pretty-printed multi-line JSON objects.
  // Accumulate lines and parse when brace depth returns to zero.
  let buf: string[] = [];
  let depth = 0;

  for await (const line of stream.lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const ch of trimmed) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }

    buf.push(trimmed);

    if (depth === 0 && buf.length > 0) {
      const block = buf.join("");
      buf = [];

      try {
        const entry = JSON.parse(block);

        if (out.isJson()) {
          console.log(JSON.stringify(entry));
        } else {
          out.text(logTable.row([
            formatTimestamp(entry.timestamp ?? ""),
            entry.region ?? "",
            entry.level ?? "",
            entry.message ?? "",
          ]));
        }
      } catch {
        out.dim(`  ${block}`);
      }
    }
  }

  const result = await stream.done;
  if (!result.ok && result.stderr) {
    out.err(result.stderr.trim());
  }
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "logs",
  description: "Stream logs for a workload app",
  usage: "ambit logs <app>.<network> [--region <r>] [--no-tail] [--json]",
  run: logs,
});
