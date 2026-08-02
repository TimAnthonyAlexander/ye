import type { Config } from "../config/index.ts";
import { assemble } from "../pipeline/assemble.ts";
import type { SessionState } from "../pipeline/state.ts";
import type { Message, Provider } from "../providers/index.ts";
import { appendUsageRecord } from "../storage/index.ts";

const FRAMING =
    "[Side question. Answer it directly from the conversation above. Neither this " +
    "question nor your answer is kept — the conversation continues as if this " +
    "exchange never happened, so do not reference it later.]";

export interface AsideInput {
    readonly state: SessionState;
    readonly provider: Provider;
    readonly config: Config;
    readonly model: string;
    readonly question: string;
    readonly signal?: AbortSignal;
    onDelta(text: string): void;
}

// One off-the-record model call: the assembled context plus a question that is
// never written to state.history or the session JSONL, so neither the next turn
// nor a resume ever sees it.
export const runAside = async (input: AsideInput): Promise<string> => {
    const { state, provider, config, model, question } = input;
    const base = await assemble({ state, model, providerId: provider.id });
    const messages: Message[] = [...base, { role: "user", content: `${FRAMING}\n\n${question}` }];

    let answer = "";
    for await (const evt of provider.stream({
        model,
        messages,
        ...(input.signal ? { signal: input.signal } : {}),
        providerOptions: {
            providerOrder: config.defaultModel.providerOrder,
            allowFallbacks: config.defaultModel.allowFallbacks,
            providerSort: config.defaultModel.providerSort,
        },
    })) {
        if (evt.type === "text.delta") {
            answer += evt.text;
            input.onDelta(evt.text);
        }
        if (evt.type === "usage") {
            try {
                await appendUsageRecord({
                    sessionId: state.sessionId,
                    projectId: state.projectId,
                    provider: provider.id,
                    model,
                    inputTokens: evt.usage.inputTokens,
                    outputTokens: evt.usage.outputTokens,
                    ...(evt.usage.cacheReadTokens !== undefined
                        ? { cacheReadTokens: evt.usage.cacheReadTokens }
                        : {}),
                    ...(evt.usage.cacheCreationTokens !== undefined
                        ? { cacheCreationTokens: evt.usage.cacheCreationTokens }
                        : {}),
                    ...(evt.usage.costUsd !== undefined ? { costUsd: evt.usage.costUsd } : {}),
                    callKind: "turn",
                });
            } catch {
                // best-effort
            }
        }
        if (evt.type === "stop") break;
    }
    return answer.trim();
};
