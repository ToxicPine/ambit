import { build, emptyDir } from "@deno/dnt";
import { parseArgs } from "@std/cli";

const args = parseArgs(Deno.args, { boolean: ["publish"] });

// Local builds use file: path; --publish uses semver for npm
const ambitVersion = args.publish ? "^0.1.0" : "file:../../ambit/npm";

const ambitMapping = (subPath: string) => ({
  name: "@ambit/cli",
  version: ambitVersion,
  subPath,
});

await emptyDir("./npm");

await build({
  entryPoints: [
    "./main.ts",
    {
      kind: "bin",
      name: "ambit-mcp",
      path: "./main.ts",
    },
    { name: "./setup", path: "./setup.ts" },
  ],
  outDir: "./npm",
  shims: {
    deno: true,
  },
  mappings: {
    "../ambit/src/schemas/config.ts": ambitMapping("schemas/config"),
    "../ambit/src/providers/fly.ts": ambitMapping("providers/fly"),
    "../ambit/src/providers/tailscale.ts": ambitMapping("providers/tailscale"),
    "../ambit/lib/cli.ts": ambitMapping("lib/cli"),
    "../ambit/lib/paths.ts": ambitMapping("lib/paths"),
    "../ambit/lib/command.ts": ambitMapping("lib/command"),
    "../ambit/src/credentials.ts": ambitMapping("src/credentials"),
  },
  typeCheck: false,
  test: false,
  scriptModule: false,
  compilerOptions: {
    lib: ["ES2022"],
    target: "ES2022",
  },
  package: {
    name: "@ambit/mcp",
    version: "0.1.0",
    description: "MCP server for managing Fly.io infrastructure via ambit",
    license: "MIT",
    engines: {
      node: ">=18",
    },
  },
});
