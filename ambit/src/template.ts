// =============================================================================
// Template - Fetch Deploy Templates from GitHub Repositories
// =============================================================================
//
// Downloads a subdirectory from a GitHub repository for use as a deploy
// template. Templates are expected to contain at least a fly.toml and
// typically a Dockerfile.
//
// Reference format: owner/repo/path[@ref]
//
//   ToxicPine/ambit-templates/cdp          → default branch
//   ToxicPine/ambit-templates/cdp@v1.0     → tagged release
//   ToxicPine/ambit-templates/cdp@main     → explicit branch
//
// =============================================================================

import { join } from "@std/path";
import { runCommand } from "@/lib/command.ts";
import type { Result } from "@/lib/result.ts";

// =============================================================================
// Error Types
// =============================================================================

/** Kinds of errors that can occur when fetching a template from GitHub. */
export type TemplateErrorKind =
  | "NotFound"
  | "RateLimited"
  | "HttpError"
  | "ExtractionFailed"
  | "PathNotFound"
  | "PathNotDirectory"
  | "EmptyArchive"
  | "NetworkError";

// =============================================================================
// Types
// =============================================================================

/** Parsed GitHub template reference. */
export interface TemplateRef {
  owner: string;
  repo: string;
  path: string;
  ref: string | undefined;
}

/** Result of fetching a template from GitHub. */
export type TemplateFetchResult = Result<
  { tempDir: string; templateDir: string },
  TemplateErrorKind
>;

// =============================================================================
// Internal Helpers
// =============================================================================

/** Shorthand for returning a typed fetch error. */
const fail = (
  kind: TemplateErrorKind,
  message: string,
): TemplateFetchResult => ({
  ok: false,
  kind,
  message,
});

/** Format a template reference for display. */
const formatRef = (ref: TemplateRef): string =>
  `${ref.owner}/${ref.repo}/${ref.path}` + (ref.ref ? `@${ref.ref}` : "");

/** Format owner/repo with optional ref for display. */
const formatRepo = (ref: TemplateRef): string =>
  `${ref.owner}/${ref.repo}` + (ref.ref ? `@${ref.ref}` : "");

// =============================================================================
// Parse Template Reference
// =============================================================================

/**
 * Parse a template reference string into its components.
 * Returns null if the format is invalid.
 *
 * Format: owner/repo/path[@ref]
 *
 * The first two segments are always owner/repo. Everything after the second
 * slash up to an optional @ref is the path within the repository. This is
 * unambiguous because GitHub owner and repo names cannot contain slashes.
 */
export const parseTemplateRef = (raw: string): TemplateRef | null => {
  // Split off @ref suffix
  const atIndex = raw.lastIndexOf("@");
  let body: string;
  let ref: string | undefined;

  if (atIndex > 0) {
    body = raw.slice(0, atIndex);
    ref = raw.slice(atIndex + 1);
    if (!ref) return null;
  } else {
    body = raw;
  }

  // Need at least owner/repo/path
  const parts = body.split("/");
  if (parts.length < 3) return null;

  const owner = parts[0];
  const repo = parts[1];
  const path = parts.slice(2).join("/");

  if (!owner || !repo || !path) return null;

  return { owner, repo, path, ref };
};

// =============================================================================
// Fetch Template
// =============================================================================

/**
 * Download a template from GitHub and extract the target subdirectory
 * to a temp directory.
 *
 * On success, returns the temp dir (for cleanup) and the path to the
 * extracted template directory. The caller is responsible for removing
 * tempDir when done.
 *
 * On failure, cleans up the temp dir and returns a typed error.
 */
export const fetchTemplate = async (
  ref: TemplateRef,
): Promise<TemplateFetchResult> => {
  const tempDir = Deno.makeTempDirSync({ prefix: "ambit-template-" });

  const cleanup = () => {
    try {
      Deno.removeSync(tempDir, { recursive: true });
    } catch { /* ignore */ }
  };

  const cleanFail = (
    kind: TemplateErrorKind,
    message: string,
  ): TemplateFetchResult => {
    cleanup();
    return fail(kind, message);
  };

  try {
    const url = ref.ref
      ? `https://api.github.com/repos/${ref.owner}/${ref.repo}/tarball/${ref.ref}`
      : `https://api.github.com/repos/${ref.owner}/${ref.repo}/tarball`;

    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ambit-cli",
      },
    });

    if (!response.ok) {
      const repo = formatRepo(ref);

      if (response.status === 404) {
        return cleanFail(
          "NotFound",
          `Template Repository Not Found: ${repo}. ` +
            "Check that the repository exists and is public.",
        );
      }

      if (response.status === 403) {
        return cleanFail(
          "RateLimited",
          "GitHub API Rate Limit Exceeded. Try again later.",
        );
      }

      return cleanFail(
        "HttpError",
        `GitHub API Returned HTTP ${response.status} for ${repo}`,
      );
    }

    // Write tarball to disk
    const tarballPath = join(tempDir, "template.tar.gz");
    const tarball = new Uint8Array(await response.arrayBuffer());
    Deno.writeFileSync(tarballPath, tarball);

    // Extract
    const extractDir = join(tempDir, "extract");
    Deno.mkdirSync(extractDir);

    const extractResult = await runCommand([
      "tar",
      "xzf",
      tarballPath,
      "-C",
      extractDir,
    ]);

    if (!extractResult.success) {
      return cleanFail(
        "ExtractionFailed",
        "Failed to Extract Template Archive",
      );
    }

    // GitHub tarballs have a single top-level dir (owner-repo-commitish/)
    const entries = [...Deno.readDirSync(extractDir)];
    const topLevel = entries.find((e) => e.isDirectory);

    if (!topLevel) {
      return cleanFail(
        "EmptyArchive",
        "Template Archive Has No Top-Level Directory",
      );
    }

    // Locate the template subdirectory
    const templateDir = join(extractDir, topLevel.name, ref.path);

    try {
      const stat = Deno.statSync(templateDir);
      if (!stat.isDirectory) {
        return cleanFail(
          "PathNotDirectory",
          `Template Path '${ref.path}' Is Not a Directory in ${formatRepo(ref)}`,
        );
      }
    } catch {
      return cleanFail(
        "PathNotFound",
        `Template Path '${ref.path}' Not Found in ${formatRepo(ref)}`,
      );
    }

    return { ok: true, tempDir, templateDir };
  } catch (e) {
    if (e instanceof TypeError) {
      return cleanFail(
        "NetworkError",
        "Network Error: Could Not Reach GitHub",
      );
    }

    cleanup();
    throw e;
  }
};
