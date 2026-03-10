// =============================================================================
// StreamTable - Fixed-Width Column Formatter for Streaming Output
// =============================================================================
//
// Unlike @cliffy/table which needs all rows upfront to calculate widths,
// StreamTable uses fixed column widths so rows can be rendered one at a time.
// Each method returns a string — pass it to out.text() for JSON mode guard.
//
// =============================================================================

import { bold, dim } from "@/lib/cli.ts";

// =============================================================================
// Types
// =============================================================================

export interface Column {
  name: string;
  width: number;
}

export interface StreamTableOptions {
  indent?: number;
  padding?: number;
}

// =============================================================================
// StreamTable
// =============================================================================

export class StreamTable {
  private columns: Column[];
  private indent: string;
  private padding: string;

  constructor(columns: Column[], opts?: StreamTableOptions) {
    this.columns = columns;
    this.indent = " ".repeat(opts?.indent ?? 2);
    this.padding = " ".repeat(opts?.padding ?? 2);
  }

  /** Render the header row (bold column names). */
  header(): string {
    return this.indent + this.columns
      .map((col, i) => bold(this.pad(col.name, col.width, i)))
      .join(this.padding);
  }

  /** Render a separator line under the header. */
  separator(): string {
    return this.indent + dim(
      this.columns
        .map((col, i) => {
          const w = this.effectiveWidth(col.width, i);
          return w > 0 ? "─".repeat(w) : "─".repeat(col.name.length);
        })
        .join(this.padding),
    );
  }

  /** Render a single data row. */
  row(values: string[]): string {
    return this.indent + this.columns
      .map((col, i) => this.pad(values[i] ?? "", col.width, i))
      .join(this.padding);
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private effectiveWidth(width: number, index: number): number {
    // width=0 on last column means unbounded
    if (width === 0 && index === this.columns.length - 1) return 0;
    // width=0 on non-last column falls back to header name length
    if (width === 0) return this.columns[index].name.length;
    return width;
  }

  private pad(value: string, width: number, index: number): string {
    const w = this.effectiveWidth(width, index);
    if (w === 0) return value; // unbounded last column
    if (value.length > w) return value.slice(0, w - 1) + "…";
    return value.padEnd(w);
  }
}
