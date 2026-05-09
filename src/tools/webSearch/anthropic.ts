import type { Message, Provider } from "../../providers/index.ts";
import { appendUsageRecord } from "../../storage/index.ts";

export interface AnthropicSearchArgs {
    readonly provider: Provider;
    readonly model: string;
    readonly query: string;
    readonly allowedDomains?: readonly string[];
    readonly blockedDomains?: readonly string[];
    readonly signal: AbortSignal;
    readonly sessionId: string;
    readonly projectId: string;
}

const buildBuiltinTool = (a: AnthropicSearchArgs): Record<string, unknown> => {
    const tool: Record<string, unknown> = { type: "web_search_20250305", name: "web_search" };
    if (a.allowedDomains && a.allowedDomains.length > 0) {
        tool["allowed_domains"] = a.allowedDomains;
    }
    if (a.blockedDomains && a.blockedDomains.length > 0) {
        tool["blocked_domains"] = a.blockedDomains;
    }
    return tool;
};

const PROMPT = (q: string): string =>
    "Search the web for: " +
    q +
    "\n\n" +
    "Reply with ONLY a markdown list of the top 10 most relevant results, one per line, in this exact format:\n" +
    "- [Title of result](https://full-url)\n" +
    "Do not include any other prose, headings, summaries, or commentary. The full URL must be from the actual search result, not invented.";

export const runAnthropicSearch = async (a: AnthropicSearchArgs): Promise<string> => {
    const messages: Message[] = [{ role: "user", content: PROMPT(a.query) }];
    let text = "";
    for await (const evt of a.provider.stream({
        model: a.model,
        messages,
        signal: a.signal,
        maxTokens: 2048,
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
                    callKind: "webSearch",
                });
            } catch {
                // best-effort
            }
        }
        if (evt.type === "stop") {
            if (evt.reason === "error" && evt.error) {
                throw new Error(`anthropic search error: ${evt.error}`);
            }
            break;
        }
    }
    return text.trim();
};
