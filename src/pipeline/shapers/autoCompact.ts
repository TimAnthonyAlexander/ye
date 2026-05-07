import type { Config } from "../../config/index.ts";
import type { Message, Provider } from "../../providers/index.ts";
import { estimateTokens } from "./tokens.ts";
import type { Shaper, ShaperContext, ShaperResult } from "./types.ts";

const PRESERVE_RECENT = 4;
const SUMMARY_PROMPT =
    "Summarize the conversation above in <=300 words. Preserve names of files, " +
    "functions, and decisions made. The summary will replace the older messages.";

const summarize = async (
    provider: Provider,
    config: Config,
    toCompact: readonly Message[],
): Promise<string> => {
    const summarizationMessages: Message[] = [
        ...toCompact,
        { role: "user", content: SUMMARY_PROMPT },
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

// Last-resort shaper. Spends a model call to summarize older history into a
// single message. After Phase 4's cheaper shapers (Snip, Microcompact, Context
// Collapse) land in front of this, autoCompact should rarely fire.
const run = async (ctx: ShaperContext): Promise<ShaperResult> => {
    const { state, messages, provider, config } = ctx;

    if (state.compactedThisTurn) return "skip";

    const threshold = config.compact?.threshold ?? 0.5;
    const tokens = estimateTokens(messages);
    if (tokens / state.contextWindow < threshold) return "skip";

    if (state.history.length <= PRESERVE_RECENT) return "skip";

    const olderHistory = state.history.slice(0, state.history.length - PRESERVE_RECENT);
    const recentHistory = state.history.slice(state.history.length - PRESERVE_RECENT);

    const summary = await summarize(provider, config, olderHistory);
    if (summary.length === 0) return "skip";

    state.history = [
        { role: "system", content: `Earlier conversation summary:\n${summary}` },
        ...recentHistory,
    ];
    state.compactedThisTurn = true;
    return "applied";
};

export const autoCompact: Shaper = {
    name: "autoCompact",
    run,
};
