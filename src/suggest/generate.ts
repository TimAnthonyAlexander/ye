import type { Config } from "../config/index.ts";
import { resolveInternalCall } from "../providers/internalCall.ts";
import type { Provider } from "../providers/types.ts";
import { appendUsageRecord } from "../storage/usage.ts";
import {
    MAX_SUGGESTION_TOKENS,
    buildSuggestionMessages,
    sanitizeSuggestion,
} from "./suggestion.ts";

export interface GenerateSuggestionInput {
    readonly config: Config;
    readonly activeProvider: Provider;
    readonly activeModel: string;
    readonly lastUserPrompt: string;
    readonly lastAssistantText: string;
    readonly sessionId: string;
    readonly projectId: string;
    readonly signal?: AbortSignal;
}

// Never throws: a suggestion that fails to generate is a suggestion that never
// appears, and nothing about that is worth showing the user.
export const generateSuggestion = async (
    input: GenerateSuggestionInput,
): Promise<string | null> => {
    const target = resolveInternalCall({
        config: input.config,
        kind: "suggestion",
        activeProvider: input.activeProvider,
        activeModel: input.activeModel,
    });
    let collected = "";
    let errored = false;
    try {
        const stream = target.provider.stream({
            model: target.model,
            messages: buildSuggestionMessages(input.lastUserPrompt, input.lastAssistantText),
            temperature: 0,
            maxTokens: MAX_SUGGESTION_TOKENS,
            signal: input.signal,
            stream: false,
            // Falling back to the active model carries its routing options,
            // which may have reasoning on. A one-line guess never needs it.
            providerOptions: { ...target.providerOptions, reasoning: false },
        });
        for await (const evt of stream) {
            if (evt.type === "text.delta") collected += evt.text;
            else if (evt.type === "usage") {
                try {
                    await appendUsageRecord({
                        sessionId: input.sessionId,
                        projectId: input.projectId,
                        provider: target.provider.id,
                        model: target.model,
                        inputTokens: evt.usage.inputTokens,
                        outputTokens: evt.usage.outputTokens,
                        ...(evt.usage.cacheReadTokens !== undefined
                            ? { cacheReadTokens: evt.usage.cacheReadTokens }
                            : {}),
                        ...(evt.usage.cacheCreationTokens !== undefined
                            ? { cacheCreationTokens: evt.usage.cacheCreationTokens }
                            : {}),
                        ...(evt.usage.costUsd !== undefined ? { costUsd: evt.usage.costUsd } : {}),
                        callKind: "suggestion",
                    });
                } catch {
                    // best-effort
                }
            } else if (evt.type === "stop" && evt.error) errored = true;
        }
    } catch {
        return null;
    }
    return errored ? null : sanitizeSuggestion(collected);
};
