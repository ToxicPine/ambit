// =============================================================================
// Shell Command Helpers
// =============================================================================

import { spawn } from "node:child_process";
import { Spinner } from "./cli.ts";

// =============================================================================
// Command Result Type
// =============================================================================

export interface CommandResult {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

// =============================================================================
// Run Command
// =============================================================================

/**
 * Run a command and capture output.
 */
export const runCommand = (
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: "inherit" | "null" | "piped";
  },
): Promise<CommandResult> => {
  const [cmd, ...cmdArgs] = args;

  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
      stdio: [
        options?.stdin === "inherit" ? "inherit" : "ignore",
        "pipe",
        "pipe",
      ],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));

    child.on("error", (error) => {
      resolve({
        success: false,
        code: -1,
        stdout: "",
        stderr: error.message,
      });
    });

    child.on("close", (code) => {
      resolve({
        success: code === 0,
        code: code ?? 1,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
    });
  });
};

// =============================================================================
// Run Command with JSON Output
// =============================================================================

/**
 * Run a command that outputs JSON and parse it.
 */
export const runCommandJson = async <T>(
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
  },
): Promise<{ success: boolean; data?: T; error?: string }> => {
  const result = await runCommand(args, options);

  if (!result.success) {
    return {
      success: false,
      error: result.stderr || `Command failed with code ${result.code}`,
    };
  }

  try {
    const data = JSON.parse(result.stdout) as T;
    return { success: true, data };
  } catch {
    return {
      success: false,
      error: `Failed to parse JSON output: ${result.stdout.slice(0, 100)}`,
    };
  }
};

// =============================================================================
// Run with Spinner
// =============================================================================

/**
 * Run a command while showing a spinner.
 */
export const runWithSpinner = async (
  label: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
  },
): Promise<CommandResult> => {
  const spinner = new Spinner();
  spinner.start(label);

  const result = await runCommand(args, options);

  if (result.success) {
    spinner.success(label);
  } else {
    spinner.fail(label);
  }

  return result;
};

// =============================================================================
// Run Quiet
// =============================================================================

/**
 * Run a command with spinner and return simplified result.
 */
export const runQuiet = async (
  label: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
  },
): Promise<{ success: boolean; output: string }> => {
  const result = await runWithSpinner(label, args, options);
  return {
    success: result.success,
    output: result.stdout + result.stderr,
  };
};

// =============================================================================
// Run Interactive
// =============================================================================

/**
 * Run a command interactively (inherits stdio).
 */
export const runInteractive = (
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
  },
): Promise<{ success: boolean; code: number }> => {
  const [cmd, ...cmdArgs] = args;

  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
      stdio: "inherit",
    });

    child.on("error", () => {
      resolve({ success: false, code: -1 });
    });

    child.on("close", (code) => {
      resolve({ success: (code ?? 1) === 0, code: code ?? 1 });
    });
  });
};
