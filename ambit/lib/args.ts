// =============================================================================
// Strict Argument Validation — rejects unknown flags via out.die()
// =============================================================================

import { createOutput } from "@/lib/output.ts";

/**
 * Validates parsed args against the declared options spec.
 * Dies with a Title Case error if unknown flags or unexpected positional
 * arguments are found.  Pass the same options object you gave to parseArgs.
 *
 * `maxPositional` (default 0) limits how many bare positional args are
 * allowed.  Set it to the number the command actually expects.
 */
export const checkArgs = (
  args: Record<string, unknown>,
  opts: {
    string?: readonly string[] | string[];
    boolean?: readonly string[] | string[];
    alias?: Record<string, string | string[]>;
    collect?: readonly string[] | string[];
  },
  command: string,
  maxPositional = 0,
): void => {
  const known = new Set<string>(["_"]);
  for (const k of opts.string ?? []) known.add(k);
  for (const k of opts.boolean ?? []) known.add(k);
  for (const k of opts.collect ?? []) known.add(k);
  for (const [k, v] of Object.entries(opts.alias ?? {})) {
    known.add(k);
    for (const a of Array.isArray(v) ? v : [v]) known.add(a);
  }

  const bad = Object.keys(args)
    .filter((k) => !known.has(k))
    .map((k) => `--${k}`);

  if (bad.length > 0) {
    const out = createOutput<Record<string, unknown>>(!!args.json);
    out.die(
      `Unknown Flag(s): ${bad.join(", ")}. Run '${command} --help' for Usage.`,
    );
  }

  const positional = Array.isArray(args._) ? args._ : [];
  if (positional.length > maxPositional) {
    const extra = positional.slice(maxPositional).join(", ");
    const out = createOutput<Record<string, unknown>>(!!args.json);
    out.die(
      `Unexpected Argument(s): ${extra}. Run '${command} --help' for Usage.`,
    );
  }
};
