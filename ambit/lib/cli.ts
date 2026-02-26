// =============================================================================
// CLI Utilities - Colors, Spinner, Status Output
// =============================================================================

// ANSI Color Codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

// =============================================================================
// Text Formatting
// =============================================================================

export const bold = (text: string): string => `${BOLD}${text}${RESET}`;
export const dim = (text: string): string => `${DIM}${text}${RESET}`;
export const red = (text: string): string => `${RED}${text}${RESET}`;
export const green = (text: string): string => `${GREEN}${text}${RESET}`;
export const yellow = (text: string): string => `${YELLOW}${text}${RESET}`;
export const blue = (text: string): string => `${BLUE}${text}${RESET}`;
export const cyan = (text: string): string => `${CYAN}${text}${RESET}`;

// =============================================================================
// Status Output
// =============================================================================

export const statusOk = (message: string): void => {
  console.log(`${green("✓")} ${message}`);
};

export const statusWarn = (message: string): void => {
  console.log(`${yellow("!")} ${message}`);
};

export const statusErr = (message: string): void => {
  console.log(`${red("✗")} ${message}`);
};

export const statusInfo = (message: string): void => {
  console.log(`${blue("•")} ${message}`);
};

// =============================================================================
// Die - Exit with Error
// =============================================================================

export const die = (message: string): never => {
  statusErr(message);
  Deno.exit(1);
};

// =============================================================================
// Spinner
// =============================================================================

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private intervalId: number | null = null;
  private frameIndex = 0;
  private message = "";

  start(message: string): void {
    this.stop();
    this.message = message;
    this.frameIndex = 0;

    const encoder = new TextEncoder();
    const write = (text: string) => Deno.stdout.writeSync(encoder.encode(text));

    this.intervalId = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIndex];
      write(`\r${cyan(frame)} ${this.message}`);
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
    }, 80);
  }

  update(message: string): void {
    this.message = message;
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      const encoder = new TextEncoder();
      Deno.stdout.writeSync(encoder.encode("\r\x1b[K"));
    }
  }

  success(message: string): void {
    this.stop();
    statusOk(message);
  }

  fail(message: string): void {
    this.stop();
    statusErr(message);
  }
}

// =============================================================================
// Prompts
// =============================================================================

export const prompt = async (message: string): Promise<string> => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(message));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return "";

  return decoder.decode(buf.subarray(0, n)).trim();
};

export const confirm = async (message: string): Promise<boolean> => {
  const answer = await prompt(`${message} [y/N] `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
};

export const readSecret = async (message: string): Promise<string> => {
  if (!Deno.stdin.isTerminal) {
    return await prompt(message);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(message));

  let echoDisabled = false;
  try {
    const sttyOff = await new Deno.Command("stty", {
      args: ["-echo"],
      stdin: "inherit",
      stdout: "null",
      stderr: "null",
    }).output();
    echoDisabled = sttyOff.success;

    const buf = new Uint8Array(1024);
    const n = await Deno.stdin.read(buf);
    if (n === null) return "";

    return decoder.decode(buf.subarray(0, n)).trim();
  } finally {
    if (echoDisabled) {
      await new Deno.Command("stty", {
        args: ["echo"],
        stdin: "inherit",
        stdout: "null",
        stderr: "null",
      }).output();
    }
    await Deno.stdout.write(encoder.encode("\n"));
  }
};

// =============================================================================
// File Utilities
// =============================================================================

export const fileExists = async (path: string): Promise<boolean> => {
  return Deno.stat(path)
    .then(() => true)
    .catch(() => false);
};

// =============================================================================
// Config Directory
// =============================================================================

export const getConfigDir = (): string => {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
  return `${home}/.config/ambit`;
};

export const getConfigPath = (): string => {
  return `${getConfigDir()}/config.json`;
};

export const ensureConfigDir = async (): Promise<void> => {
  const dir = getConfigDir();
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      return;
    }
    throw error;
  }
};

// =============================================================================
// Random ID Generation
// =============================================================================

export const randomId = (length: number = 6): string => {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(
    { length },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
};

// =============================================================================
// Command Exists Check
// =============================================================================

export const commandExists = async (command: string): Promise<boolean> => {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("which", [command], {
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
};
