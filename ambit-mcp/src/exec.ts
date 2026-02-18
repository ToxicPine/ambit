// =============================================================================
// ambit-mcp: Fly CLI Executor
// =============================================================================
// Thin wrapper around Deno.Command that runs `fly <args>` and optionally
// parses JSON output through a Zod schema.
// =============================================================================

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
export async function exec(args: string[]): Promise<ExecResult> {
  const cmd = new Deno.Command("fly", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const child = await cmd.output();
  const stdout = new TextDecoder().decode(child.stdout);
  const stderr = new TextDecoder().decode(child.stderr);

  return {
    stdout,
    stderr,
    success: child.success,
    code: child.code,
  };
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
      `fly ${args[0]} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  return schema.parse(parsed);
}

/**
 * Run `fly <args>`, parse newline-delimited JSON (NDJSON) through a schema.
 * Used for commands like `fly logs --json` that output one JSON object per line.
 */
export async function execNdjson<T>(
  args: string[],
  schema: z.ZodType<T>,
): Promise<T[]> {
  const result = await exec(args);
  if (!result.success) {
    throw new Error(
      `fly ${args[0]} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  const lines = result.stdout.trim().split("\n").filter((l) => l.length > 0);
  return lines.map((line) => schema.parse(JSON.parse(line)));
}
