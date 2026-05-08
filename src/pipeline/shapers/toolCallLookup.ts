import type { Message } from "../../providers/index.ts";

// Walk history backwards looking for the assistant message whose tool_calls
// includes `id`, and return that call's function name. Returns undefined if no
// match — should not happen for a well-formed history but the caller treats
// missing as "unknown" rather than throwing.
export const findToolNameForCallId = (
    history: readonly Message[],
    id: string,
): string | undefined => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const m = history[i];
        if (!m || m.role !== "assistant" || !m.tool_calls) continue;
        for (const tc of m.tool_calls) {
            if (tc.id === id) return tc.function.name;
        }
    }
    return undefined;
};
