#!/usr/bin/env -S deno run -A

const run = async (cmd: string, args: string[], cwd?: string) => {
  const p = new Deno.Command(cmd, {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) Deno.exit(code);
};

const build = (dir: string) =>
  run("deno", ["run", "-A", "scripts/build_npm.ts", "--publish"], dir);

const publish = async (dir: string) => {
  const pkg = JSON.parse(await Deno.readTextFile(`${dir}/package.json`));
  const p = new Deno.Command("npm", {
    args: ["publish", "--access", "public"],
    cwd: dir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "piped",
  });
  const result = await p.output();
  const stderr = new TextDecoder().decode(result.stderr);
  if (stderr) Deno.stderr.writeSync(new TextEncoder().encode(stderr));
  if (result.code !== 0) {
    if (stderr.includes("You cannot publish over the previously published")) {
      console.log(`${pkg.name}@${pkg.version} already published, skipping`);
      return;
    }
    Deno.exit(result.code);
  }
};

// Phase 1: Build + publish ambit (base — others depend on it)
console.log("\n=== @cardelli/ambit ===\n");
await build("./ambit");
await publish("./ambit/npm");

// Phase 2: Build + publish dependents
console.log("\n=== @cardelli/mcp ===\n");
await build("./ambit-mcp");
await publish("./ambit-mcp/npm");

console.log("\n=== All Packages Published ===\n");
