import { build, emptyDir } from "@deno/dnt";

type BuildOptions = Parameters<typeof build>[0];
type EntryPoint = NonNullable<BuildOptions["entryPoints"]>[number];
type BuildOverrides = Omit<
  BuildOptions,
  "entryPoints" | "outDir" | "package" | "postBuild"
>;

type DenoConfig = {
  name: string;
  version: string;
  description: string;
  license: string;
  exports?: string | Record<string, string>;
  imports?: Record<string, string>;
};

type PathMapping = { name: string; version: string; subPath: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringRecord = (value: unknown): value is Record<string, string> => {
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
};

const expectString = (value: unknown, fieldName: string): string => {
  if (typeof value !== "string") {
    throw new Error(`Invalid deno.json: ${fieldName} must be a string`);
  }
  return value;
};

const parseExports = (value: unknown): DenoConfig["exports"] => {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (isStringRecord(value)) return value;
  throw new Error("Invalid deno.json: exports must be a string or a string map");
};

const parseImports = (value: unknown): DenoConfig["imports"] => {
  if (value === undefined) return undefined;
  if (isStringRecord(value)) return value;
  throw new Error("Invalid deno.json: imports must be a string map");
};

export const parseDenoConfig = (raw: unknown): DenoConfig => {
  if (!isRecord(raw)) {
    throw new Error("Invalid deno.json: expected an object");
  }

  const { name, version, description, license, exports, imports } = raw;

  return {
    name: expectString(name, "name"),
    version: expectString(version, "version"),
    description: expectString(description, "description"),
    license: expectString(license, "license"),
    exports: parseExports(exports),
    imports: parseImports(imports),
  };
};

export const entryPointsFromExports = (denoConfig: DenoConfig): EntryPoint[] => {
  if (!denoConfig.exports || typeof denoConfig.exports === "string") {
    return [];
  }

  return Object.entries(denoConfig.exports)
    .filter(([name, path]) => name !== "." && path.endsWith(".ts"))
    .map(([name, path]) => ({ name, path }));
};

export const createPathMappingsFromImports = (options: {
  imports?: Record<string, string>;
  fromPrefix: string;
  packageName: string;
  packageVersion: string;
}): Record<string, PathMapping> => {
  const mappings: Record<string, PathMapping> = {};
  if (!options.imports) return mappings;

  for (const path of Object.values(options.imports)) {
    if (!path.startsWith(options.fromPrefix)) continue;
    const subPath = path.replace(options.fromPrefix, "").replace(/\.ts$/, "");
    mappings[path] = {
      name: options.packageName,
      version: options.packageVersion,
      subPath,
    };
  }

  return mappings;
};

export const createPathMappingsFromExports = (options: {
  exports?: string | Record<string, string>;
  sourcePathPrefix: string;
  packageName: string;
  packageVersion: string;
  onlySubPaths?: Iterable<string>;
}): Record<string, PathMapping> => {
  const mappings: Record<string, PathMapping> = {};
  if (!options.exports || typeof options.exports === "string") return mappings;
  const allowedSubPaths = options.onlySubPaths
    ? new Set(options.onlySubPaths)
    : undefined;

  const sourcePathPrefix = options.sourcePathPrefix.endsWith("/")
    ? options.sourcePathPrefix
    : `${options.sourcePathPrefix}/`;

  for (const [exportName, exportPath] of Object.entries(options.exports)) {
    if (exportName === "." || !exportPath.endsWith(".ts")) continue;

    if (!exportName.startsWith("./")) {
      throw new Error(
        `Invalid Export Key "${exportName}": expected "." or "./subpath"`,
      );
    }

    const subPath = exportName.slice(2);
    if (allowedSubPaths && !allowedSubPaths.has(subPath)) continue;
    const normalizedExportPath = exportPath.startsWith("./")
      ? exportPath.slice(2)
      : exportPath;

    mappings[`${sourcePathPrefix}${normalizedExportPath}`] = {
      name: options.packageName,
      version: options.packageVersion,
      subPath,
    };
  }

  return mappings;
};

const readImportedSpecifiers = (sourceText: string): string[] => {
  const specifiers: string[] = [];
  const fromRe = /\bfrom\s+["']([^"']+)["']/g;
  const dynamicImportRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const re of [fromRe, dynamicImportRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(sourceText)) !== null) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
};

export const discoverImportedSubPaths = async (options: {
  rootDir: string;
  packageName: string;
  fileExtensions?: string[];
  ignoreDirs?: string[];
}): Promise<Set<string>> => {
  const subPaths = new Set<string>();
  const fileExtensions = new Set(options.fileExtensions ?? [".ts", ".tsx"]);
  const ignoreDirs = new Set(options.ignoreDirs ?? ["npm", "node_modules", ".git"]);

  const walk = async (dir: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (ignoreDirs.has(entry.name)) continue;
        await walk(path);
        continue;
      }

      if (!entry.isFile) continue;
      if (![...fileExtensions].some((ext) => entry.name.endsWith(ext))) continue;

      const text = await Deno.readTextFile(path);
      for (const specifier of readImportedSpecifiers(text)) {
        if (!specifier.startsWith(`${options.packageName}/`)) continue;
        subPaths.add(specifier.slice(options.packageName.length + 1));
      }
    }
  };

  await walk(options.rootDir);
  return subPaths;
};

export const buildNpmPackage = async (options: {
  denoConfigRaw: unknown;
  binName: string;
  binPath?: string;
  outDir?: string;
  includeExportEntryPoints?: boolean;
  extraEntryPoints?: EntryPoint[];
  buildOverrides?: Partial<BuildOverrides>;
  postBuild?: () => Promise<void> | void;
}) => {
  const denoConfig = parseDenoConfig(options.denoConfigRaw);
  const outDir = options.outDir ?? "./npm";
  const includeExportEntryPoints = options.includeExportEntryPoints ?? false;
  const buildOverrides = options.buildOverrides ?? {};

  const entryPoints: EntryPoint[] = [
    {
      kind: "bin",
      name: options.binName,
      path: options.binPath ?? "./main.ts",
    },
    ...(includeExportEntryPoints ? entryPointsFromExports(denoConfig) : []),
    ...(options.extraEntryPoints ?? []),
  ];

  await emptyDir(outDir);

  await build({
    shims: {
      deno: true,
      ...(buildOverrides.shims ?? {}),
    },
    typeCheck: false,
    test: false,
    scriptModule: false,
    compilerOptions: {
      lib: ["ES2022"],
      target: "ES2022",
      ...(buildOverrides.compilerOptions ?? {}),
    },
    ...buildOverrides,
    entryPoints,
    outDir,
    package: {
      name: denoConfig.name,
      version: denoConfig.version,
      description: denoConfig.description,
      license: denoConfig.license,
      engines: {
        node: ">=18",
      },
    },
    postBuild: options.postBuild,
  });
};
