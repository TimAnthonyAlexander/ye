import type { Message, Provider } from "../../providers/index.ts";
import { appendUsageRecord } from "../../storage/index.ts";

export interface OpenRouterFetchArgs {
    readonly provider: Provider;
    readonly model: string;
    readonly url: string;
    readonly question: string;
    readonly maxContentTokens?: number;
    readonly allowedDomains?: readonly string[];
    readonly blockedDomains?: readonly string[];
    readonly signal: AbortSignal;
    readonly sessionId: string;
    readonly projectId: string;
}

const buildBuiltinTool = (a: OpenRouterFetchArgs): Record<string, unknown> => {
    const tool: Record<string, unknown> = { type: "openrouter:web_fetch" };
    if (a.maxContentTokens && a.maxContentTokens > 0) {
        tool["max_content_tokens"] = a.maxContentTokens;
    }
    if (a.allowedDomains && a.allowedDomains.length > 0) {
        tool["allowed_domains"] = a.allowedDomains;
    }
    if (a.blockedDomains && a.blockedDomains.length > 0) {
        tool["blocked_domains"] = a.blockedDomains;
    }
    return tool;
};

const RULES = [
    "Use ONLY the fetched page content to answer.",
    "Quotes longer than 125 characters must be paraphrased; shorter quotes may be reproduced verbatim.",
    "Do not reproduce song lyrics.",
    "If the page does not contain the answer, say so plainly.",
].join("\n- ");

const buildPrompt = (a: OpenRouterFetchArgs): string =>
    [
        "Fetch the following URL and answer the question below.",
        "URL: " + a.url,
        "",
        "Question: " + a.question,
        "",
        "Rules:",
        "- " + RULES,
    ].join("\n");

export const runOpenRouterFetch = async (a: OpenRouterFetchArgs): Promise<string> => {
    const messages: Message[] = [{ role: "user", content: buildPrompt(a) }];
    let text = "";
    for await (const evt of a.provider.stream({
        model: a.model,
        messages,
        signal: a.signal,
        maxTokens: 1024,
        providerOptions: { builtinTools: [buildBuiltinTool(a)] },
    })) {
        if (evt.type === "text.delta") text += evt.text;
        else if (evt.type === "usage") {
            try {
                await appendUsageRecord({
                    sessionId: a.sessionId,
                    projectId: a.projectId,
                    provider: a.provider.id,
                    model: a.model,
                    inputTokens: evt.usage.inputTokens,
                    outputTokens: evt.usage.outputTokens,
                    ...(evt.usage.cacheReadTokens !== undefined
                        ? { cacheReadTokens: evt.usage.cacheReadTokens }
                        : {}),
                    ...(evt.usage.cacheCreationTokens !== undefined
                        ? { cacheCreationTokens: evt.usage.cacheCreationTokens }
                        : {}),
                    ...(evt.usage.costUsd !== undefined ? { costUsd: evt.usage.costUsd } : {}),
                    callKind: "webFetch",
                });
            } catch {
                // best-effort
            }
        }
        if (evt.type === "stop") {
            if (evt.reason === "error" && evt.error) {
                throw new Error(`openrouter fetch error: ${evt.error.message}`);
            }
            break;
        }
    }
    return text.trim();
};
