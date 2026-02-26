// =============================================================================
// Result<T> — Shared Success/Failure Type
// =============================================================================

export class Result<T> {
  private constructor(
    readonly ok: boolean,
    private readonly _value: T | undefined,
    private readonly _error: string | undefined,
  ) {}

  static ok<T>(value: T): Result<T> {
    return new Result<T>(true, value, undefined);
  }

  static err<T = never>(error: string): Result<T> {
    return new Result<T>(false, undefined, error);
  }

  get value(): T | undefined {
    return this._value;
  }

  get error(): string | undefined {
    return this._error;
  }

  map<U>(fn: (value: T) => U): Result<U> {
    if (this.ok) return Result.ok(fn(this._value!));
    return Result.err(this._error!);
  }

  flatMap<U>(fn: (value: T) => Result<U>): Result<U> {
    if (this.ok) return fn(this._value!);
    return Result.err(this._error!);
  }

  unwrap(): T {
    if (this.ok) return this._value!;
    throw new Error(this._error);
  }

  unwrapOr(fallback: T): T {
    return this.ok ? this._value! : fallback;
  }

  match<U>(cases: { ok: (value: T) => U; err: (error: string) => U }): U {
    return this.ok ? cases.ok(this._value!) : cases.err(this._error!);
  }
}
