#!/usr/bin/env -S deno run -A

const run = async (cmd: string, args: string[], cwd?: string) => {
  const p = new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) Deno.exit(code);
};

const build = (dir: string) =>
  run("deno", ["run", "-A", "scripts/build_npm.ts", "--publish"], dir);

const publish = (dir: string) =>
  run("npm", ["publish", "--access", "public"], dir);

// Phase 1: Build + publish ambit (base — others depend on it)
console.log("\n=== @cardelli/ambit ===\n");
await build("./ambit");
await publish("./ambit/npm");

// Phase 2: Build + publish dependents (parallel build, sequential publish)
console.log("\n=== @cardelli/chromatic + @cardelli/mcp ===\n");
await Promise.all([build("./chromatic"), build("./ambit-mcp")]);
await publish("./chromatic/npm");
await publish("./ambit-mcp/npm");

console.log("\n=== All packages published ===\n");
