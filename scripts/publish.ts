#!/usr/bin/env -S deno run -A

const ensureInstalled = async (cmd: string) => {
  try {
    const p = new Deno.Command(cmd, { args: ["--version"], stdout: "piped", stderr: "piped" });
    await p.output();
  } catch {
    console.error(`${cmd} Is Not Installed`);
    Deno.exit(1);
  }
};

await ensureInstalled("npm");

const run = async (cmd: string, args: string[], cwd?: string) => {
  const p = new Deno.Command(cmd, {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) {
    console.error(`Command Failed: ${cmd} ${args.join(" ")}`);
    Deno.exit(code);
  }
};

const build = (dir: string) =>
  run("deno", ["run", "-A", "scripts/build_npm.ts", "--publish"], dir);

const isPublished = async (name: string, version: string): Promise<boolean> => {
  const p = new Deno.Command("npm", {
    args: ["view", `${name}@${version}`, "version"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code } = await p.output();
  return code === 0;
};

const publish = async (dir: string) => {
  const pkg = JSON.parse(await Deno.readTextFile(`${dir}/package.json`));

  if (await isPublished(pkg.name, pkg.version)) {
    console.log(`Already Published ${pkg.name}@${pkg.version}, Skipping`);
    return;
  }

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
    console.error(`Failed To Publish ${pkg.name}@${pkg.version}`);
    Deno.exit(result.code);
  }
  console.log(`Published ${pkg.name}@${pkg.version}`);
};

console.log("\n=== @cardelli/ambit ===\n");
await build("./ambit");
await publish("./ambit/npm");

console.log("\n=== All Packages Published ===\n");
