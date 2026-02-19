// =============================================================================
// ambit-mcp: Fly CLI Executor
// =============================================================================
// Thin wrapper around node:child_process that runs `fly <args>` and optionally
// parses JSON output through a Zod schema. Uses node:child_process directly
// instead of Deno.Command so the npm build works under Node.js without a shim.
// =============================================================================

import { spawn } from "node:child_process";
import type { z } from "@zod/zod";

export interface ExecResult {
  stdout: string;
  stderr: string;
  success: boolean;
  code: number;
}

/**
 * Run `fly <args>` and return raw stdout/stderr/exit code.
 */
export function exec(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("fly", args, { stdio: ["ignore", "pipe", "pipe"] });

    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        success: code === 0,
        code: code ?? 1,
      });
    });
  });
}

/**
 * Run `fly <args>`, expect JSON stdout, parse through a Zod schema.
 * Throws on non-zero exit or parse failure.
 */
export async function execJson<T>(
  args: string[],
  schema: z.ZodType<T>,
): Promise<T> {
  const result = await exec(args);
  if (!result.success) {
    throw new Error(
      `fly ${args[0]} failed (exit ${result.code}): ${
        result.stderr || result.stdout
      }`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  return schema.parse(parsed);
}

/**
 * Run `fly <args>`, parse newline-delimited JSON (NDJSON) through a schema.
 * Used for commands like `fly logs --json` that output one JSON object per line.
 * Non-JSON lines (status messages, warnings) are silently skipped.
 */
export async function execNdjson<T>(
  args: string[],
  schema: z.ZodType<T>,
): Promise<T[]> {
  const result = await exec(args);
  if (!result.success) {
    throw new Error(
      `fly ${args[0]} failed (exit ${result.code}): ${
        result.stderr || result.stdout
      }`,
    );
  }
  const lines = result.stdout.trim().split("\n");
  const entries: T[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    entries.push(schema.parse(JSON.parse(trimmed)));
  }
  return entries;
}
