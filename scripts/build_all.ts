#!/usr/bin/env -S deno run -A
import { parseArgs } from "@std/cli";
import denoRawConfig from "../deno.json" with { type: "json" };
import { z } from "jsr:@zod/zod@^4.0.0";
import { parseDenoConfig } from "./build_npm_core.ts";

const denoSchema = z.object({
  workspace: z.array(z.string()),
}).loose();

const denoConfig = denoSchema.parse(denoRawConfig);

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
    throw new Error(`${label} Build Failed: exit code ${code}`);
  }
  console.log(`\n--- ${label} Done ---\n`);
};

for (const dir of denoConfig.workspace) {
  const packageConfig = parseDenoConfig(
    JSON.parse(await Deno.readTextFile(`${dir}/deno.json`)),
  );
  await run(dir, packageConfig.name);
}
