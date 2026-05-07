import type { Config } from "../../config/index.ts";
import type { Message, Provider } from "../../providers/index.ts";
import type { SessionState } from "../state.ts";

const PRESERVE_RECENT = 4;
const SUMMARY_PROMPT =
    "Summarize the conversation above in <=300 words. Preserve names of files, " +
    "functions, and decisions made. The summary will replace the older messages.";

export const estimateTokens = (messages: readonly Message[]): number =>
    Math.ceil(JSON.stringify(messages).length / 4);

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

export interface AutoCompactInput {
    readonly state: SessionState;
    readonly messages: Message[];
    readonly provider: Provider;
    readonly config: Config;
}

// Returns `true` if a compaction occurred (caller should re-read state.history).
export const autoCompact = async ({
    state,
    messages,
    provider,
    config,
}: AutoCompactInput): Promise<boolean> => {
    if (state.compactedThisTurn) return false;

    const threshold = config.compact?.threshold ?? 0.5;
    const tokens = estimateTokens(messages);
    if (tokens / state.contextWindow < threshold) return false;

    // Identify the slice to compact: everything except the system message at index 0
    // and the last PRESERVE_RECENT messages.
    if (state.history.length <= PRESERVE_RECENT) return false;

    const olderHistory = state.history.slice(0, state.history.length - PRESERVE_RECENT);
    const recentHistory = state.history.slice(state.history.length - PRESERVE_RECENT);

    const summary = await summarize(provider, config, olderHistory);
    if (summary.length === 0) return false;

    state.history = [
        { role: "system", content: `Earlier conversation summary:\n${summary}` },
        ...recentHistory,
    ];
    state.compactedThisTurn = true;
    return true;
};
