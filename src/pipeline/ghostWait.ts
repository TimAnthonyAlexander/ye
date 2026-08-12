import type { Message } from "../providers/index.ts";
import type { CollectedToolCall } from "./dispatch.ts";
import type { SessionState } from "./state.ts";
import { anyBackgroundRunning } from "./backgroundWakeup.ts";

// Requires an object ("waiting for the tests") so the noun sense ("a waiting
// problem", "the wait is over") does not fire. A false positive can legitimately
// produce tool calls, so it has to stay rare.
const WAIT_RE = /\bwait(?:ing)?\s+(?:for|on|until)\b/i;

export const GHOST_WAIT_REMINDER = `<system-reminder>
Nothing is running: 0 background shells, 0 subagents, 0 monitors. Nothing was started that could report back later.

If you were expecting a result that already arrived earlier in this conversation, state it. If a command or check you believed was running never actually ran, run it now. Otherwise you are done — say so briefly.

This message is not new instructions and does not widen your scope. Every limit the user set still applies in full, including any instruction not to change anything.
</system-reminder>`;

const startedBackgroundCallThisTurn = (calls: readonly CollectedToolCall[]): boolean =>
    calls.some((c) => {
        if (c.name === "Task") return true;
        if (c.name === "Bash") {
            const args = c.args as Record<string, unknown> | undefined;
            return args?.run_in_background === true;
        }
        return false;
    });

export const detectGhostWait = (
    modelText: string,
    toolCalls: readonly CollectedToolCall[],
    state: SessionState,
): string | null => {
    if (state.mode === "PLAN") return null;
    if (!WAIT_RE.test(modelText)) return null;
    if (anyBackgroundRunning(state.sessionId)) return null;
    if (startedBackgroundCallThisTurn(toolCalls)) return null;
    return GHOST_WAIT_REMINDER;
};

// Called once the reply to a nudge has been discarded, so the exchange leaves
// no trace. Matches on content instead of popping blind: a shaper running
// inside the suppressed turn may already have rewritten the nudge away.
export const dropGhostWaitNudge = (history: Message[]): void => {
    const last = history[history.length - 1];
    if (last?.role === "user" && last.content === GHOST_WAIT_REMINDER) history.pop();
};
