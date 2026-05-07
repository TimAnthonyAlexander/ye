import type { SessionState } from "./state.ts";
import type { StopReason } from "./events.ts";

export interface StopInput {
  readonly state: SessionState;
  readonly turnIndex: number;
  readonly maxTurns: number;
  readonly hadToolCalls: boolean;
}

const PLAN_LOOP_GUARD_THRESHOLD = 2;

// Step 9. Returns the stop reason, or null to keep looping.
//   - end_turn:        model returned no tool calls
//   - max_turns:       turn budget exhausted
//   - plan_loop_guard: PLAN-mode same-tool denials hit the threshold
// Other reasons (context_overflow, user_cancel, error) are decided elsewhere
// and short-circuit before this is called.
export const evaluateStop = ({
  state,
  turnIndex,
  maxTurns,
  hadToolCalls,
}: StopInput): StopReason | null => {
  if (
    state.mode === "PLAN" &&
    state.denialTrail !== null &&
    state.denialTrail.count >= PLAN_LOOP_GUARD_THRESHOLD
  ) {
    return "plan_loop_guard";
  }
  if (!hadToolCalls) return "end_turn";
  if (turnIndex + 1 >= maxTurns) return "max_turns";
  return null;
};
