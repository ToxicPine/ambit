// =============================================================================
// Shell Command Helpers
// =============================================================================

import { Spinner, statusOk, statusErr } from "./cli.ts";

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
export const runCommand = async (
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: "inherit" | "null" | "piped";
  }
): Promise<CommandResult> => {
  const [cmd, ...cmdArgs] = args;

  try {
    const command = new Deno.Command(cmd, {
      args: cmdArgs,
      cwd: options?.cwd,
      env: options?.env,
      stdin: options?.stdin ?? "null",
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout, stderr } = await command.output();
    const decoder = new TextDecoder();

    return {
      success: code === 0,
      code,
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
    };
  } catch (error) {
    return {
      success: false,
      code: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
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
  }
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
  }
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
  }
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
export const runInteractive = async (
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
  }
): Promise<{ success: boolean; code: number }> => {
  const [cmd, ...cmdArgs] = args;

  try {
    const command = new Deno.Command(cmd, {
      args: cmdArgs,
      cwd: options?.cwd,
      env: options?.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    const { code } = await command.output();
    return { success: code === 0, code };
  } catch {
    return { success: false, code: -1 };
  }
};
