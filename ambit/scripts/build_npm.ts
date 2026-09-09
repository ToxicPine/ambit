import config from "../deno.json" with { type: "json" };
import { copy, emptyDir } from "@std/fs";

const packageDir = new URL("../", import.meta.url);
const outDir = new URL("npm/", packageDir);
await emptyDir(outDir);
await Deno.mkdir(new URL("cli/", outDir));

// Keep the bundle one directory below router/, matching the relative asset
// lookup in util/constants.ts. Bundling resolves import maps and inlines JSR
// dependencies so npm consumers don't need a separate registry configured.
const bundle = new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--frozen",
    "--format=esm",
    "--output",
    "npm/cli/main.js",
    "main.ts",
  ],
  cwd: packageDir,
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await bundle.output();
if (code !== 0) throw new Error(`Bundle Failed: exit code ${code}`);

// Load the shim before evaluating any application modules. Calling run()
// explicitly also works on Node versions without import.meta.main support.
await Deno.writeTextFile(
  new URL("bin.mjs", outDir),
  `#!/usr/bin/env node
import { Deno } from "@deno/shim-deno";
Object.assign(globalThis, { Deno });
const { run } = await import("./cli/main.js");
await run();
`,
);
if (Deno.build.os !== "windows") {
  await Deno.chmod(new URL("bin.mjs", outDir), 0o755);
}

await Deno.writeTextFile(
  new URL("package.json", outDir),
  JSON.stringify(
    {
      name: config.name,
      version: config.version,
      description: config.description,
      license: config.license,
      type: "module",
      bin: { ambit: "./bin.mjs" },
      files: ["bin.mjs", "cli/", "router/"],
      engines: { node: ">=18" },
      dependencies: { "@deno/shim-deno": "0.19.2" },
    },
    null,
    2,
  ) + "\n",
);
await copy(new URL("router/", packageDir), new URL("router/", outDir));
await Deno.copyFile(
  new URL("README.md", packageDir),
  new URL("README.md", outDir),
);
