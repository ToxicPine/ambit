import { build, emptyDir } from "@deno/dnt";
import { copy } from "@std/fs";
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
      name: "chromatic",
      path: "./main.ts",
    },
  ],
  outDir: "./npm",
  shims: {
    deno: true,
  },
  mappings: {
    "../ambit/lib/cli.ts": ambitMapping("lib/cli"),
    "../ambit/lib/command.ts": ambitMapping("lib/command"),
    "../ambit/lib/output.ts": ambitMapping("lib/output"),
    "../ambit/src/providers/fly.ts": ambitMapping("providers/fly"),
    "../ambit/src/providers/tailscale.ts": ambitMapping("providers/tailscale"),
    "../ambit/src/schemas/fly.ts": ambitMapping("schemas/fly"),
    "../ambit/src/credentials.ts": ambitMapping("src/credentials"),
    "../ambit/src/discovery.ts": ambitMapping("src/discovery"),
    "../ambit/src/resolve.ts": ambitMapping("src/resolve"),
  },
  typeCheck: false,
  test: false,
  scriptModule: false,
  compilerOptions: {
    lib: ["ES2022"],
    target: "ES2022",
  },
  package: {
    name: "@ambit/chromatic",
    version: "0.2.0",
    description: "CDP instance manager for Fly.io + Tailscale",
    license: "MIT",
    engines: {
      node: ">=18",
    },
  },
  async postBuild() {
    await copy("./src/docker", "./npm/esm/src/docker", { overwrite: true });
  },
});
