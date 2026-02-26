// =============================================================================
// State Machine - Hydrate → Interpret → Run Pattern
// =============================================================================

import { Result } from "@/lib/result.ts";

/** A state machine phase with a transition function. */
export interface Machine<Phase extends string, Ctx> {
  /** The terminal phase — when reached, the machine stops. */
  terminal: Phase;
  /** Execute the transition for the given phase. Returns the next phase. */
  transition: (phase: Phase, ctx: Ctx) => Promise<Result<Phase>>;
}

/** Run a state machine from an initial phase to its terminal phase. */
export const runMachine = async <Phase extends string, Ctx>(
  machine: Machine<Phase, Ctx>,
  initial: Phase,
  ctx: Ctx,
): Promise<Result<Phase>> => {
  let phase = initial;
  while (phase !== machine.terminal) {
    const result = await machine.transition(phase, ctx);
    if (!result.ok) return result;
    phase = result.value!;
  }
  return Result.ok(phase);
};
