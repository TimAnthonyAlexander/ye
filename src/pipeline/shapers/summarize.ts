import type { Message, Provider } from "../../providers/index.ts";
import type { Config } from "../../config/index.ts";
import { estimateTokens } from "./tokens.ts";
import type { ShaperContext, ShaperResult } from "./types.ts";

export type SummaryPromptStyle = "auto-compact" | "collapse";

export interface SummarizeOptions {
    readonly preserveRecent: number;
    readonly promptStyle: SummaryPromptStyle;
}

export interface SummarizeOutcome {
    readonly result: ShaperResult;
    readonly freedTokens: number;
}

const PROMPT_AUTO_COMPACT =
    "Summarize the conversation above in <=300 words. Preserve names of files, " +
    "functions, and decisions made. The summary will replace the older messages.";

const PROMPT_COLLAPSE =
    "Summarize the older conversation above in <=200 words. Preserve names of " +
    "files, functions, and decisions made. The recent conversation is preserved " +
    "verbatim and follows; this summary replaces only the older portion.";

const promptFor = (style: SummaryPromptStyle): string =>
    style === "collapse" ? PROMPT_COLLAPSE : PROMPT_AUTO_COMPACT;

const hasToolCalls = (m: Message): boolean =>
    m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;

// Walk the proposed boundary backwards (shrinking `older`, growing `recent`)
// until the cut won't orphan a tool-call/tool-result pair across the divide.
// Returns the adjusted boundary index, or 0 if no clean cut exists in this
// history (caller treats that as "skip"). Two bad cases we move past:
//   1. recent[0] is a tool message — its paired assistant is in older.
//   2. older's last message is an assistant with tool_calls — its results
//      are now in recent.
// Both produce "orphaned tool result"-style provider rejections.
const findCleanBoundary = (history: readonly Message[], proposed: number): number => {
    let i = Math.max(0, Math.min(proposed, history.length));
    while (i > 0) {
        const recentHead = history[i];
        const olderTail = history[i - 1];
        if (recentHead && recentHead.role === "tool") {
            i -= 1;
            continue;
        }
        if (olderTail && hasToolCalls(olderTail)) {
            i -= 1;
            continue;
        }
        break;
    }
    return i;
};

const summarize = async (
    provider: Provider,
    config: Config,
    toCompact: readonly Message[],
    style: SummaryPromptStyle,
): Promise<string> => {
    const summarizationMessages: Message[] = [
        ...toCompact,
        { role: "user", content: promptFor(style) },
    ];
    let summary = "";
    for await (const evt of provider.stream({
        model: config.defaultModel.model,
        messages: summarizationMessages,
        providerOptions: {
            providerOrder: config.defaultModel.providerOrder,
            allowFallbacks: config.defaultModel.allowFallbacks,
        },
    })) {
        if (evt.type === "text.delta") summary += evt.text;
        if (evt.type === "stop") break;
    }
    return summary.trim();
};

// Slice older history at a clean boundary, summarize it via a model call, and
// replace state.history with [summarySystemMessage, ...recent]. Used by both
// autoCompact and contextCollapse — they differ only in tunables.
export const runSummarizeAndReplace = async (
    ctx: ShaperContext,
    opts: SummarizeOptions,
): Promise<SummarizeOutcome> => {
    const { state, provider, config } = ctx;

    if (state.history.length <= opts.preserveRecent) {
        return { result: "skip", freedTokens: 0 };
    }

    const proposed = state.history.length - opts.preserveRecent;
    const boundary = findCleanBoundary(state.history, proposed);
    if (boundary <= 0) {
        return { result: "skip", freedTokens: 0 };
    }

    const olderHistory = state.history.slice(0, boundary);
    const recentHistory = state.history.slice(boundary);

    const beforeTokens = estimateTokens(olderHistory);

    const summary = await summarize(provider, config, olderHistory, opts.promptStyle);
    if (summary.length === 0) {
        return { result: "skip", freedTokens: 0 };
    }

    const summaryMessage: Message = {
        role: "system",
        content: `Earlier conversation summary:\n${summary}`,
    };
    const afterTokens = estimateTokens([summaryMessage]);
    const freedTokens = Math.max(0, beforeTokens - afterTokens);

    state.history = [summaryMessage, ...recentHistory];
    return { result: "applied", freedTokens };
};
