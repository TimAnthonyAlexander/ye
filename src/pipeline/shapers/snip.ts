import type { Message } from "../../providers/index.ts";
import { estimateMessageTokens, estimateTokens } from "./tokens.ts";
import type { Shaper, ShaperContext, ShaperResult } from "./types.ts";

const DEFAULT_THRESHOLD = 0.35;
const DEFAULT_FLOOR = 0.3;
const DEFAULT_PROTECTED_TAIL = 8;
const DEFAULT_MAX_PER_TURN = 10;

export const SNIP_STUB = "[snipped: stale tool result]";

interface Candidate {
    readonly index: number;
    readonly size: number;
}

// Drops the largest old tool results, replacing them with a tiny stub. Each
// stub keeps its tool_call_id so providers don't reject the message as an
// orphaned tool result. Candidate set is restricted to indices outside the
// protected tail, sized largest-first; we stop once the projected token count
// falls below snipFloor or we hit snipMaxPerTurn.
const run = async (ctx: ShaperContext): Promise<ShaperResult> => {
    const { state, messages, config, budget } = ctx;
    if (state.shapingFlags.snip) return "skip";

    const threshold = config.compact?.snipThreshold ?? DEFAULT_THRESHOLD;
    const floor = config.compact?.snipFloor ?? DEFAULT_FLOOR;
    const protectedTail = config.compact?.snipProtectedTail ?? DEFAULT_PROTECTED_TAIL;
    const maxPerTurn = config.compact?.snipMaxPerTurn ?? DEFAULT_MAX_PER_TURN;

    const tokens = estimateTokens(messages);
    if (tokens / state.contextWindow < threshold) return "skip";

    const protectedStart = state.history.length - protectedTail;
    if (protectedStart <= 0) return "skip";

    const candidates: Candidate[] = [];
    for (let i = 0; i < protectedStart; i += 1) {
        const m = state.history[i];
        if (!m || m.role !== "tool") continue;
        if (m.tool_call_id === undefined) continue;
        if (m.content === SNIP_STUB) continue;
        candidates.push({ index: i, size: estimateMessageTokens(m) });
    }
    if (candidates.length === 0) return "skip";

    candidates.sort((a, b) => b.size - a.size);

    const floorTokens = floor * state.contextWindow;
    const stubProbeSize = estimateMessageTokens({
        role: "tool",
        tool_call_id: "x",
        content: SNIP_STUB,
    });

    let current = tokens;
    let snipped = 0;
    let freed = 0;

    for (const cand of candidates) {
        if (snipped >= maxPerTurn) break;
        if (current < floorTokens) break;
        const m = state.history[cand.index];
        if (!m || m.tool_call_id === undefined) continue;
        const stub: Message = {
            role: "tool",
            tool_call_id: m.tool_call_id,
            content: SNIP_STUB,
        };
        state.history[cand.index] = stub;
        const delta = cand.size - stubProbeSize;
        current -= delta;
        freed += delta;
        snipped += 1;
    }

    if (snipped === 0) return "skip";

    state.shapingFlags.snip = true;
    budget.tokensFreedThisTurn += freed;
    return "applied";
};

export const snip: Shaper = {
    name: "snip",
    run,
};
