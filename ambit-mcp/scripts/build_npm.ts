import denoRawConfig from "../deno.json" with { type: "json" };
import ambitRawConfig from "../../ambit/deno.json" with { type: "json" };
import { parseArgs } from "@std/cli";
import {
  buildNpmPackage,
  createPathMappingsFromExports,
  discoverImportedSubPaths,
  parseDenoConfig,
} from "../../scripts/build_npm_core.ts";

const args = parseArgs(Deno.args, { boolean: ["publish"] });
const mcpConfig = parseDenoConfig(denoRawConfig);
const ambitConfig = parseDenoConfig(ambitRawConfig);
const ambitVersion = args.publish
  ? `^${ambitConfig.version}`
  : "file:../../ambit/npm";
const usedAmbitSubPaths = await discoverImportedSubPaths({
  rootDir: ".",
  packageName: ambitConfig.name,
});
const mappings = createPathMappingsFromExports({
  exports: ambitConfig.exports,
  sourcePathPrefix: "../ambit/",
  packageName: ambitConfig.name,
  packageVersion: ambitVersion,
  onlySubPaths: usedAmbitSubPaths,
});

await buildNpmPackage({
  denoConfigRaw: denoRawConfig,
  binName: "ambit-mcp",
  extraEntryPoints: [{ name: "./setup", path: "./setup.ts" }],
  buildOverrides: { mappings },
});
