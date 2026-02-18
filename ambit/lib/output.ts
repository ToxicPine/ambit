// =============================================================================
// Output - Unified Output Handling for CLI Commands
// =============================================================================

import {
  bold,
  dim,
  Spinner,
  statusErr,
  statusInfo,
  statusOk,
  statusWarn,
} from "./cli.ts";

// =============================================================================
// Result Types - Discriminated Union Base Types
// =============================================================================

export type SuccessResult<T> = { ok: true } & T;
export type ErrorResult = { ok: false; error: string };

// =============================================================================
// Output Class
// =============================================================================

export class Output<T extends Record<string, unknown>> {
  private result:
    | SuccessResult<T>
    | (ErrorResult & Record<string, unknown>)
    | null = null;
  private jsonMode: boolean;

  constructor(jsonMode: boolean) {
    this.jsonMode = jsonMode;
  }

  // ===========================================================================
  // Result Data
  // ===========================================================================

  // Set success result — produces { ok: true, ...data }
  done(data: T): this {
    this.result = { ok: true, ...data } as SuccessResult<T>;
    return this;
  }

  // Set error result (non-fatal) — produces { ok: false, error, ...data }
  fail(error: string, data?: Record<string, unknown>): this {
    this.result = { ok: false, error, ...data };
    return this;
  }

  // ===========================================================================
  // Human-Mode Output (no-op in JSON mode)
  // ===========================================================================

  ok(text: string): this {
    if (!this.jsonMode) statusOk(text);
    return this;
  }

  err(text: string): this {
    if (!this.jsonMode) statusErr(text);
    return this;
  }

  info(text: string): this {
    if (!this.jsonMode) statusInfo(text);
    return this;
  }

  warn(text: string): this {
    if (!this.jsonMode) statusWarn(text);
    return this;
  }

  text(text: string): this {
    if (!this.jsonMode) console.log(text);
    return this;
  }

  dim(text: string): this {
    if (!this.jsonMode) console.log(dim(text));
    return this;
  }

  header(text: string): this {
    if (!this.jsonMode) console.log(bold(text));
    return this;
  }

  blank(): this {
    if (!this.jsonMode) console.log();
    return this;
  }

  // JSON-aware spinner — no-op in JSON mode
  spinner(
    message: string,
  ): { success(msg: string): void; fail(msg: string): void; stop(): void } {
    if (this.jsonMode) {
      return { success: () => {}, fail: () => {}, stop: () => {} };
    }
    const s = new Spinner();
    s.start(message);
    return {
      success: (msg: string) => s.success(msg),
      fail: (msg: string) => s.fail(msg),
      stop: () => s.stop(),
    };
  }

  // ===========================================================================
  // Terminal Output
  // ===========================================================================

  // Print result as JSON (no-op in human mode)
  print(): void {
    if (this.jsonMode && this.result) {
      console.log(JSON.stringify(this.result, null, 2));
    }
  }

  // Fatal error — outputs { ok: false, error } and exits
  die(message: string): never {
    if (this.jsonMode) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      statusErr(message);
    }
    Deno.exit(1);
  }

  // Check if in JSON mode
  isJson(): boolean {
    return this.jsonMode;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createOutput<T extends Record<string, unknown>>(
  jsonMode: boolean,
): Output<T> {
  return new Output(jsonMode);
}
