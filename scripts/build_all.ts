#!/usr/bin/env -S deno run -A
import { parseArgs } from "@std/cli";

const args = parseArgs(Deno.args, { boolean: ["publish"] });
const extra = args.publish ? ["--publish"] : [];

const run = async (dir: string, label: string): Promise<void> => {
  console.log(`\n--- Building ${label} ---\n`);
  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", "scripts/build_npm.ts", ...extra],
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) {
    throw new Error(`${label} build failed with exit code ${code}`);
  }
  console.log(`\n--- ${label} done ---\n`);
};

// Phase 1: Base package (no internal deps)
await run("./ambit", "@ambit/cli");

// Phase 2: Dependent packages (parallel)
await Promise.all([
  run("./chromatic", "@ambit/chromatic"),
  run("./ambit-mcp", "@ambit/mcp"),
]);

console.log("\n=== All packages built ===\n");
