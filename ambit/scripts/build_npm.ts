import denoRawConfig from "@/deno.json" with { type: "json" };
import { copy } from "@std/fs";
import { buildNpmPackage } from "../../scripts/build_npm_core.ts";

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

await buildNpmPackage({
  denoConfigRaw: denoRawConfig,
  binName: "ambit",
  includeExportEntryPoints: true,
  async postBuild() {
    await copy("./router", "./npm/esm/src/router", { overwrite: true });
    await Deno.copyFile("./README.md", "./npm/README.md");
    await stripDenoShebang("./npm/esm/main.js");
  },
});
