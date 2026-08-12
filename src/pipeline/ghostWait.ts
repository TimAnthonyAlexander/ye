import type { Message } from "../providers/index.ts";
import type { CollectedToolCall } from "./dispatch.ts";
import type { SessionState } from "./state.ts";
import { anyBackgroundRunning } from "./backgroundWakeup.ts";

const WAIT_RE = /\bwait(?:ing)?\b/i;

export const GHOST_WAIT_REMINDER = `<system-reminder>
Your text says you are waiting, but nothing is actually running: 0 background bash tasks, 0 subagents, and 0 monitors. If your work is already done, say "done." Only continue if there is genuinely unfinished work.
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
