import type { Citation, Message, Provider } from "../../providers/index.ts";
import { appendUsageRecord } from "../../storage/index.ts";

export interface OpenRouterSearchArgs {
    readonly provider: Provider;
    readonly model: string;
    readonly query: string;
    readonly allowedDomains?: readonly string[];
    readonly blockedDomains?: readonly string[];
    readonly maxResults?: number;
    readonly signal: AbortSignal;
    readonly sessionId: string;
    readonly projectId: string;
}

export interface OpenRouterSearchResult {
    readonly text: string;
    readonly citations: readonly Citation[];
}

const buildBuiltinTool = (a: OpenRouterSearchArgs): Record<string, unknown> => {
    const tool: Record<string, unknown> = { type: "openrouter:web_search" };
    if (a.maxResults && a.maxResults > 0) tool["max_results"] = a.maxResults;
    if (a.allowedDomains && a.allowedDomains.length > 0) {
        tool["allowed_domains"] = a.allowedDomains;
    }
    // OpenRouter uses `excluded_domains` for this tool (not `blocked_domains`).
    if (a.blockedDomains && a.blockedDomains.length > 0) {
        tool["excluded_domains"] = a.blockedDomains;
    }
    return tool;
};

const PROMPT = (q: string): string =>
    "Search the web for: " +
    q +
    "\n\n" +
    "Reply with ONLY a markdown list of the top 10 most relevant results, one per line:\n" +
    "- [Title of result](https://full-url)\n" +
    "No other prose, headings, or commentary. Use the actual canonical URLs from your search tool.";

// Some upstreams (e.g. Gemini routes via OpenRouter) sometimes leak the
// model's thinking as content prefixed with a literal "thought\n…" block
// before the real answer. Strip up to the first markdown bullet so the
// formatted list survives.
const stripThoughtLeak = (s: string): string => {
    if (!/^\s*thought\b/i.test(s)) return s;
    const firstBullet = s.search(/(^|\n)\s*[-*]\s/);
    if (firstBullet === -1) return s.trim();
    return s.slice(firstBullet).trim();
};

const formatCitationsAsMarkdown = (cits: readonly Citation[], limit: number): string => {
    const lines: string[] = [];
    for (const c of cits.slice(0, limit)) {
        const title = c.title?.trim() || c.url;
        lines.push(`- [${title}](${c.url})`);
    }
    return lines.join("\n");
};

export const runOpenRouterSearch = async (
    a: OpenRouterSearchArgs,
): Promise<OpenRouterSearchResult> => {
    const messages: Message[] = [{ role: "user", content: PROMPT(a.query) }];
    let text = "";
    let citations: readonly Citation[] = [];
    for await (const evt of a.provider.stream({
        model: a.model,
        messages,
        signal: a.signal,
        maxTokens: 2048,
        providerOptions: {
            builtinTools: [buildBuiltinTool(a)],
            // Suppress reasoning surfacing — avoids "thought\n…" leakage into
            // the markdown list. Models still think internally; OpenRouter
            // just drops the reasoning tokens from the stream.
            reasoning: { exclude: true },
        },
    })) {
        if (evt.type === "text.delta") text += evt.text;
        else if (evt.type === "citations") citations = evt.citations;
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
                throw new Error(`openrouter search error: ${evt.error.message}`);
            }
            break;
        }
    }

    const limit = a.maxResults && a.maxResults > 0 ? a.maxResults : 10;

    // Citations from the engine are the canonical source — they avoid the
    // opaque vertexaisearch.cloud.google.com/grounding-api-redirect/... URLs
    // that Gemini-native routes type into the prose.
    if (citations.length > 0) {
        return {
            text: formatCitationsAsMarkdown(citations, limit),
            citations,
        };
    }

    return {
        text: stripThoughtLeak(text).trim(),
        citations: [],
    };
};
