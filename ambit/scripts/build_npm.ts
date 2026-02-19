import { build, emptyDir } from "@deno/dnt";
import { copy } from "@std/fs";

// dnt mangles Deno shebangs (#!/usr/bin/env -S deno run -A) in source files
// because it inserts shim imports above them, breaking TypeScript's shebang
// stripping. This cleans up the garbled output.
const stripDenoShebang = async (path: string) => {
  const text = await Deno.readTextFile(path);
  const fixed = text.replace(
    /^(#!\/usr\/bin\/env node\n(?:import [^\n]+\n)*)!\/usr\/bin \/ env - S;\ndeno;\nrun - A;\n/,
    "$1",
  );
  if (fixed !== text) await Deno.writeTextFile(path, fixed);
};

await emptyDir("./npm");

await build({
  entryPoints: [
    {
      kind: "bin",
      name: "ambit",
      path: "./main.ts",
    },
    { name: "./providers/fly", path: "./src/providers/fly.ts" },
    { name: "./providers/tailscale", path: "./src/providers/tailscale.ts" },
    { name: "./schemas/config", path: "./src/schemas/config.ts" },
    { name: "./schemas/fly", path: "./src/schemas/fly.ts" },
    { name: "./schemas/tailscale", path: "./src/schemas/tailscale.ts" },
    { name: "./lib/cli", path: "./lib/cli.ts" },
    { name: "./lib/command", path: "./lib/command.ts" },
    { name: "./lib/output", path: "./lib/output.ts" },
    { name: "./lib/paths", path: "./lib/paths.ts" },
    { name: "./src/credentials", path: "./src/credentials.ts" },
    { name: "./src/discovery", path: "./src/discovery.ts" },
    { name: "./src/guard", path: "./src/guard.ts" },
    { name: "./src/resolve", path: "./src/resolve.ts" },
  ],
  outDir: "./npm",
  shims: {
    deno: true,
  },
  typeCheck: false,
  test: false,
  scriptModule: false,
  compilerOptions: {
    lib: ["ES2022"],
    target: "ES2022",
  },
  package: {
    name: "@cardelli/ambit",
    version: "0.1.1",
    description: "Tailscale subnet router manager for Fly.io custom networks",
    license: "MIT",
    engines: {
      node: ">=18",
    },
  },
  async postBuild() {
    await copy("./src/docker", "./npm/esm/src/docker", { overwrite: true });
    await stripDenoShebang("./npm/esm/main.js");
  },
});
