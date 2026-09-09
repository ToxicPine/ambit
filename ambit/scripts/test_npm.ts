import { assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import config from "../deno.json" with { type: "json" };

const packageDir = new URL("../", import.meta.url);
const tempDir = await Deno.makeTempDir({ prefix: "ambit-npm-test-" });
const decoder = new TextDecoder();

const command = async (
  executable: string,
  args: string[],
  cwd: string | URL,
  expectedCode = 0,
): Promise<string> => {
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = decoder.decode(result.stdout);
  const stderr = decoder.decode(result.stderr);
  assertEquals(
    result.code,
    expectedCode,
    `${executable} ${args.join(" ")}\n${stdout}\n${stderr}`,
  );
  return stdout;
};

try {
  const packed = JSON.parse(
    await command("npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      tempDir,
    ], new URL("npm/", packageDir)),
  );
  const tarball = join(tempDir, packed[0].filename);
  const consumer = join(tempDir, "consumer");
  await Deno.mkdir(consumer);
  await Deno.writeTextFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true }),
  );
  // Scope-specific settings override npm's default registry. Explicitly point
  // JSR's scope at npm too, so a user's ~/.npmrc cannot hide a JSR dependency.
  await Deno.writeTextFile(
    join(consumer, ".npmrc"),
    "registry=https://registry.npmjs.org/\n@jsr:registry=https://registry.npmjs.org/\n",
  );
  await command("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ], consumer);

  const installed = join(consumer, "node_modules", config.name);
  const bin = join(installed, "bin.mjs");
  assertEquals(
    (await command("node", [bin, "--version"], consumer)).trim(),
    `ambit ${config.version}`,
  );
  // npm exec exercises the bin link/shim installed by npm as well as the JS.
  assertEquals(
    (await command(
      "npm",
      ["exec", "--offline", "--", "ambit", "--version"],
      consumer,
    )).trim(),
    `ambit ${config.version}`,
  );
  for (const args of [["--help"], ["create", "--help"], ["deploy", "--help"]]) {
    assertMatch(await command("node", [bin, ...args], consumer), /usage/i);
  }
  await command("node", [bin, "__unknown_command__"], consumer, 1);
  const rejected = JSON.parse(
    await command(
      "node",
      [bin, "deploy", "ambit-test.lab", "--json"],
      consumer,
      1,
    ),
  );
  assertEquals(rejected.ok, false);
  assertMatch(rejected.error, /Cannot deploy ambit infrastructure apps/);

  for (const file of ["Dockerfile", "fly.toml", "start.sh"]) {
    assertEquals(
      await Deno.readTextFile(join(installed, "router", file)),
      await Deno.readTextFile(new URL(`router/${file}`, packageDir)),
      `Packaged router/${file} must match the source asset`,
    );
  }

  console.log(
    "npm package passed: install, CLI, exit codes, router assets",
  );
} finally {
  await Deno.remove(tempDir, { recursive: true });
}
