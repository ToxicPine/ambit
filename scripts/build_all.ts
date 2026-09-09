#!/usr/bin/env -S deno run -A
import config from "../deno.json" with { type: "json" };

const rootDir = new URL("../", import.meta.url);
for (const dir of config.workspace) {
  console.log(`Building ${dir}`);
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: ["task", "build"],
    cwd: new URL(`${dir}/`, rootDir),
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) throw new Error(`${dir} Build Failed: exit code ${code}`);
}
