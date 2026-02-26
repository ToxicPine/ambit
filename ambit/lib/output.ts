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
} from "@/lib/cli.ts";

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

  print(): void {
    if (this.jsonMode && this.result) {
      console.log(JSON.stringify(this.result, null, 2));
    }
  }

  // ===========================================================================
  // Human-Mode Output (no-op in JSON mode)
  // ===========================================================================

  skip(text: string): this {
    if (!this.jsonMode) console.log(dim(`~ ${text}`));
    return this;
  }

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
  // Async Spinner Wrapper
  // ===========================================================================

  async spin<R>(label: string, fn: () => Promise<R>): Promise<R> {
    const s = this.spinner(label);
    try {
      const result = await fn();
      s.success(label);
      return result;
    } catch (e) {
      s.fail(label);
      throw e;
    }
  }

  // ===========================================================================
  // Terminal Output
  // ===========================================================================

  die(message: string): never {
    if (this.jsonMode) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      statusErr(message);
    }
    throw new Error("exit");
  }

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
