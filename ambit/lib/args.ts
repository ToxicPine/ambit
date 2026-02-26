// =============================================================================
// Strict Argument Validation — rejects unknown flags via out.die()
// =============================================================================

import { createOutput } from "@/lib/output.ts";

/**
 * Validates parsed args against the declared options spec.
 * Dies with a Title Case error if unknown flags are found.
 * Pass the same options object you gave to parseArgs.
 */
export const checkArgs = (
  args: Record<string, unknown>,
  opts: {
    string?: readonly string[] | string[];
    boolean?: readonly string[] | string[];
    alias?: Record<string, string | string[]>;
  },
  command: string,
): void => {
  const known = new Set<string>(["_"]);
  for (const k of opts.string ?? []) known.add(k);
  for (const k of opts.boolean ?? []) known.add(k);
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
};
