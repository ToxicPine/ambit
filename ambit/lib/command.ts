// =============================================================================
// Shell Command Helpers
// =============================================================================

import { spawn } from "node:child_process";
import { Result } from "@/lib/result.ts";

// =============================================================================
// Run Options
// =============================================================================

export interface RunOptions {
  interactive?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "inherit" | "null";
}

// =============================================================================
// Command Result
// =============================================================================

export class CmdResult {
  readonly ok: boolean;

  constructor(
    readonly code: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    this.ok = code === 0;
  }

  /** Parse stdout as JSON, returning Result<T>. */
  json<T>(): Result<T> {
    if (!this.ok) {
      return Result.err(this.stderr || `Command Failed With Code ${this.code}`);
    }
    try {
      return Result.ok(JSON.parse(this.stdout) as T);
    } catch {
      return Result.err(
        `Failed To Parse JSON: ${this.stdout.slice(0, 100)}`,
      );
    }
  }

  /** Merged stdout + stderr. */
  get output(): string {
    return (this.stdout + this.stderr).trimEnd();
  }
}

// =============================================================================
// Run Command
// =============================================================================

/**
 * Run a command and capture output.
 * When `interactive: true`, inherits all stdio (no capture).
 */
export const runCommand = (
  args: string[],
  options?: RunOptions,
): Promise<CmdResult> => {
  const [cmd, ...cmdArgs] = args;
  const interactive = options?.interactive ?? false;

  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
      stdio: interactive ? "inherit" : [
        options?.stdin === "inherit" ? "inherit" : "ignore",
        "pipe",
        "pipe",
      ],
    });

    if (interactive) {
      child.on("error", () => {
        resolve(new CmdResult(-1, "", ""));
      });
      child.on("close", (code) => {
        resolve(new CmdResult(code ?? 1, "", ""));
      });
      return;
    }

    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: string) => stderr.push(chunk));

    child.on("error", (error) => {
      resolve(new CmdResult(-1, "", error.message));
    });

    child.on("close", (code) => {
      resolve(new CmdResult(code ?? 1, stdout.join(""), stderr.join("")));
    });
  });
};

// =============================================================================
// Wrappers
// =============================================================================

/** Run and parse stdout as JSON. */
export const runJson = <T>(
  args: string[],
  options?: RunOptions,
): Promise<Result<T>> => runCommand(args, options).then((r) => r.json<T>());
