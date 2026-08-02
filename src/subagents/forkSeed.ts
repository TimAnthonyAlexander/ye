import type { Message } from "../providers/index.ts";

const hasToolCalls = (m: Message): boolean =>
    m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;

// Same backwards walk as findCleanBoundary in pipeline/shapers/summarize.ts,
// applied to the tail instead of a mid-history cut: the parent is mid-turn when
// it forks, so its transcript ends with an assistant message whose tool results
// do not exist yet. Handing that to a provider is an orphaned-tool-call error.
export const findCleanEnd = (history: readonly Message[]): number => {
    let i = history.length;
    while (i > 0) {
        const head = history[i];
        const tail = history[i - 1];
        if (head && head.role === "tool") {
            i -= 1;
            continue;
        }
        if (tail && hasToolCalls(tail)) {
            i -= 1;
            continue;
        }
        break;
    }
    return i;
};

// The fork's shapers mutate its history in place, so the seed must share no
// object with the parent's messages.
export const copyForkHistory = (history: readonly Message[]): Message[] => {
    const end = findCleanEnd(history);
    return structuredClone(history.slice(0, end));
};
