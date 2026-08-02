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

export interface BudgetInput {
    readonly maxUsd: number | undefined;
    readonly spentUsd: number;
}

// Flag beats config.
export const resolveBudgetCap = (
    flagUsd: number | null | undefined,
    configUsd: number | undefined,
): number | undefined => flagUsd ?? configUsd;

// Checked before the model call, not after: the point is to stop before the
// spend crosses the cap, so a session already at or past it never dispatches.
// Returns the user-facing message, or null when there is budget left.
export const evaluateBudgetStop = ({ maxUsd, spentUsd }: BudgetInput): string | null => {
    if (maxUsd === undefined || maxUsd <= 0) return null;
    if (spentUsd < maxUsd) return null;
    return (
        `Budget cap reached: $${spentUsd.toFixed(4)} spent this session against a $${maxUsd.toFixed(2)} cap. ` +
        `Stopped before the next model call. Raise the cap with --max-budget-usd or budget.maxUsd to keep going.`
    );
};

// Injected as a pseudo-user turn when the model stalls right after a plan is
// approved. Approval IS the go-ahead — the model must not wait for more.
export const PLAN_START_REMINDER = `<system-reminder>
The user approved your plan and switched you out of plan mode. Approval of the plan is the go-ahead to act — begin executing it now, starting with the first step. Do not reply with only an acknowledgement, restate the plan, or ask for further confirmation.
</system-reminder>`;

// A plan was approved on the previous turn and this turn ended without any tool
// call — the model acknowledged instead of executing. Caller injects
// PLAN_START_REMINDER and keeps looping. Gated on the "just accepted" flag so it
// fires at most once per acceptance.
export const shouldNudgePlanStart = (
    planAcceptedComingIn: boolean,
    stopReason: StopReason,
): boolean => planAcceptedComingIn && stopReason === "end_turn";
