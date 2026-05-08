import type { Message } from "../../providers/index.ts";
import { estimateMessageTokens, estimateTokens } from "./tokens.ts";
import { findToolNameForCallId } from "./toolCallLookup.ts";
import type { Shaper, ShaperContext, ShaperResult } from "./types.ts";

const DEFAULT_THRESHOLD = 0.42;
const DEFAULT_HOT_TAIL = 6;
const DEFAULT_MIN_BYTES = 1024;

export const MICROCOMPACT_PREFIX = "[microcompacted:";

const stubFor = (toolName: string, callId: string, originalChars: number): string =>
    `${MICROCOMPACT_PREFIX} tool=${toolName}, id=${callId}, size≈${originalChars}B]`;

const isAlreadyShaped = (content: string): boolean =>
    content.startsWith("[snipped:") || content.startsWith(MICROCOMPACT_PREFIX);

// Truncates every old tool result outside the hot tail whose content exceeds
// minBytes. Broader and shallower than Snip: replaces the body wholesale with
// a small descriptor stub that retains the tool name, call id, and original
// size. Preserves tool_call_id so providers don't reject orphaned tool results.
// No model call.
const run = async (ctx: ShaperContext): Promise<ShaperResult> => {
    const { state, messages, config, budget } = ctx;
    if (state.shapingFlags.microcompact) return "skip";

    const threshold = config.compact?.microcompactThreshold ?? DEFAULT_THRESHOLD;
    const hotTail = config.compact?.microcompactHotTail ?? DEFAULT_HOT_TAIL;
    const minBytes = config.compact?.microcompactMinBytes ?? DEFAULT_MIN_BYTES;

    const tokens = estimateTokens(messages);
    if (tokens / state.contextWindow < threshold) return "skip";

    const protectedStart = state.history.length - hotTail;
    if (protectedStart <= 0) return "skip";

    let truncated = 0;
    let freed = 0;

    for (let i = 0; i < protectedStart; i += 1) {
        const m = state.history[i];
        if (!m || m.role !== "tool") continue;
        if (m.tool_call_id === undefined) continue;
        if (typeof m.content !== "string") continue;
        if (m.content.length <= minBytes) continue;
        if (isAlreadyShaped(m.content)) continue;

        const oldSize = estimateMessageTokens(m);
        const toolName = findToolNameForCallId(state.history, m.tool_call_id) ?? "unknown";
        const stub: Message = {
            role: "tool",
            tool_call_id: m.tool_call_id,
            content: stubFor(toolName, m.tool_call_id, m.content.length),
        };
        state.history[i] = stub;
        freed += oldSize - estimateMessageTokens(stub);
        truncated += 1;
    }

    if (truncated === 0) return "skip";

    state.shapingFlags.microcompact = true;
    budget.tokensFreedThisTurn += freed;
    return "applied";
};

export const microcompact: Shaper = {
    name: "microcompact",
    run,
};
