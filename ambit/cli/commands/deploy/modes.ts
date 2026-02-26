// =============================================================================
// Deploy Modes — Image, Config, and Template Resolution
// =============================================================================

import { join } from "@std/path";
import { fileExists } from "@/lib/cli.ts";
import { createOutput } from "@/lib/output.ts";
import { scanFlyToml } from "@/util/guard.ts";
import { fetchTemplate, parseTemplateRef } from "@/util/template.ts";

// =============================================================================
// Deploy Config
// =============================================================================

/** Resolved deploy configuration — the output of mode-specific validation. */
export interface DeployConfig {
  image?: string;
  configPath?: string;
  preflight: { scanned: boolean; warnings: string[] };
  tempDir?: string;
}

// =============================================================================
// Image Mode
// =============================================================================

/**
 * Generate a minimal fly.toml with http_service config for auto start/stop.
 * Written to a temp directory and cleaned up after deploy.
 */
const generateServiceToml = (port: number): string =>
  `[http_service]\n` +
  `  internal_port = ${port}\n` +
  `  auto_stop_machines = "stop"\n` +
  `  auto_start_machines = true\n` +
  `  min_machines_running = 0\n`;

/**
 * Parse --main-port value. Returns the port number, or null if "none".
 * Dies on invalid input.
 */
const parseMainPort = (
  raw: string,
  out: ReturnType<typeof createOutput>,
): number | null | "error" => {
  if (raw === "none") return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    out.die(
      `Invalid --main-port: "${raw}". Use a Port Number (1-65535) or "none".`,
    );
    return "error";
  }
  return port;
};

/** Resolve deploy config for image mode (--image). */
export const resolveImageMode = (
  image: string,
  mainPortRaw: string,
  out: ReturnType<typeof createOutput>,
): DeployConfig | null => {
  const mainPort = parseMainPort(mainPortRaw, out);
  if (mainPort === "error") return null;

  const preflight: DeployConfig["preflight"] = {
    scanned: false,
    warnings: [],
  };

  if (mainPort !== null) {
    const tempDir = Deno.makeTempDirSync();
    const configPath = join(tempDir, "fly.toml");
    Deno.writeTextFileSync(configPath, generateServiceToml(mainPort));
    out.ok(`HTTP Service on Port ${mainPort} (auto start/stop)`);
    return { image, configPath, preflight, tempDir };
  }

  out.info("Image Mode — No Service Config");
  return { image, preflight };
};

// =============================================================================
// Config Mode
// =============================================================================

/** Resolve deploy config for config mode (default — uses fly.toml). */
export const resolveConfigMode = async (
  explicitConfig: string | undefined,
  out: ReturnType<typeof createOutput>,
): Promise<DeployConfig | null> => {
  let configPath = explicitConfig;
  if (!configPath && (await fileExists("./fly.toml"))) {
    configPath = "./fly.toml";
  }

  if (!configPath) {
    out.info("No fly.toml Found — Deploying Without Config Scan");
    return { preflight: { scanned: false, warnings: [] } };
  }

  if (!(await fileExists(configPath))) {
    out.die(`Config File Not Found: ${configPath}`);
    return null;
  }

  const tomlContent = await Deno.readTextFile(configPath);
  const scan = scanFlyToml(tomlContent);

  if (scan.errors.length > 0) {
    for (const err of scan.errors) {
      out.err(err);
    }
    out.die("Pre-flight Check Failed. Fix fly.toml Before Deploying.");
    return null;
  }

  for (const warn of scan.warnings) {
    out.warn(warn);
  }

  out.ok(`Scanned ${configPath}`);

  return {
    configPath,
    preflight: { scanned: scan.scanned, warnings: scan.warnings },
  };
};

// =============================================================================
// Template Mode
// =============================================================================

/** Resolve deploy config for template mode (--template). */
export const resolveTemplateMode = async (
  templateRaw: string,
  out: ReturnType<typeof createOutput>,
): Promise<DeployConfig | null> => {
  const ref = parseTemplateRef(templateRaw);

  if (!ref) {
    out.die(
      `Invalid Template Reference: "${templateRaw}". ` +
        `Format: owner/repo[/path][@ref]`,
    );
    return null;
  }

  const label =
    (ref.path === "."
      ? `${ref.owner}/${ref.repo}`
      : `${ref.owner}/${ref.repo}/${ref.path}`) +
    (ref.ref ? `@${ref.ref}` : "");
  out.info(`Template: ${label}`);

  const fetchSpinner = out.spinner("Fetching Template from GitHub");
  const result = await fetchTemplate(ref);

  if (!result.ok) {
    fetchSpinner.fail("Template Fetch Failed");
    out.die(result.error!);
    return null;
  }

  const { tempDir, templateDir } = result.value!;
  fetchSpinner.success("Template Fetched");

  const configPath = join(templateDir, "fly.toml");

  let tomlContent: string;
  try {
    tomlContent = await Deno.readTextFile(configPath);
  } catch {
    try {
      Deno.removeSync(tempDir, { recursive: true });
    } catch {
      /* ignore */
    }
    out.die(
      `Template '${ref.path === "." ? ref.repo : ref.path}' Has No fly.toml`,
    );
    return null;
  }

  const scan = scanFlyToml(tomlContent);

  if (scan.errors.length > 0) {
    try {
      Deno.removeSync(tempDir, { recursive: true });
    } catch {
      /* ignore */
    }
    for (const err of scan.errors) {
      out.err(err);
    }
    out.die("Pre-flight Check Failed for Template fly.toml");
    return null;
  }

  for (const warn of scan.warnings) {
    out.warn(warn);
  }

  out.ok(`Scanned ${ref.path === "." ? "" : ref.path + "/"}fly.toml`);

  return {
    configPath,
    preflight: { scanned: scan.scanned, warnings: scan.warnings },
    tempDir,
  };
};
