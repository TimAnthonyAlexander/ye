import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import { runAnthropicSearch } from "./anthropic.ts";
import { runBraveSearch } from "./brave.ts";
import { runDuckDuckGoSearch } from "./duckduckgo.ts";
import { runOpenRouterSearch } from "./openrouter.ts";

type Engine = "auto" | "openrouter" | "fallback";

interface WebSearchArgs {
    readonly query: string;
    readonly allowed_domains?: readonly string[];
    readonly blocked_domains?: readonly string[];
    readonly engine?: Engine;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LIMIT = 10;

const fallbackSearch = async (
    args: WebSearchArgs,
    ctx: ToolContext,
    reason: string,
): Promise<ToolResult<string>> => {
    const cfg = ctx.config.webTools ?? {};
    const fallback = cfg.searchFallback ?? "duckduckgo";
    if (fallback === "off") {
        return {
            ok: false,
            error: `WebSearch unavailable: ${reason}. Enable a fallback by setting webTools.searchFallback to "duckduckgo" in ~/.ye/config.json.`,
        };
    }

    const sharedArgs = {
        query: args.query,
        ...(args.allowed_domains ? { allowedDomains: args.allowed_domains } : {}),
        ...(args.blocked_domains ? { blockedDomains: args.blocked_domains } : {}),
        maxBytes: cfg.maxFetchBytes ?? DEFAULT_MAX_BYTES,
        limit: DEFAULT_LIMIT,
        ...(cfg ? { config: cfg } : {}),
        signal: ctx.signal,
    } as const;

    ctx.emitProgress?.([`querying brave · ${args.query}`]);
    const brave = await runBraveSearch(sharedArgs);
    if (brave.ok) {
        ctx.emitProgress?.([`got ${brave.results.length} results from brave`]);
        const lines = brave.results.map((r) => `- [${r.title}](${r.url})`);
        return { ok: true, value: lines.join("\n") };
    }

    ctx.emitProgress?.([`brave failed (${brave.error}); falling back to duckduckgo`]);
    const ddg = await runDuckDuckGoSearch(sharedArgs);
    if (ddg.ok) {
        ctx.emitProgress?.([`got ${ddg.results.length} results from duckduckgo`]);
        const lines = ddg.results.map((r) => `- [${r.title}](${r.url})`);
        return { ok: true, value: lines.join("\n") };
    }

    return {
        ok: false,
        error: `WebSearch: all providers failed — ${reason}; brave: ${brave.error}; duckduckgo: ${ddg.error}`,
    };
};

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<WebSearchArgs>(rawArgs, WebSearchTool.schema);
    if (!v.ok) return v;
    const query = v.value.query.trim();
    if (query.length < 2) return { ok: false, error: "query must be at least 2 chars" };
    const engine: Engine = v.value.engine ?? "auto";
    const normalized: WebSearchArgs = { ...v.value, query, engine };

    if (engine === "fallback") {
        ctx.emitProgress?.(["engine=fallback · skipping server-side search"]);
        return fallbackSearch(normalized, ctx, "engine=fallback requested");
    }

    if (ctx.provider.capabilities.serverSideWebSearch) {
        if (ctx.provider.id === "anthropic") {
            ctx.emitProgress?.([`querying anthropic web_search · ${query}`]);
            const text = await runAnthropicSearch({
                provider: ctx.provider,
                model: ctx.activeModel,
                query,
                ...(normalized.allowed_domains
                    ? { allowedDomains: normalized.allowed_domains }
                    : {}),
                ...(normalized.blocked_domains
                    ? { blockedDomains: normalized.blocked_domains }
                    : {}),
                signal: ctx.signal,
                sessionId: ctx.sessionId,
                projectId: ctx.projectId,
            });
            if (text.length === 0) {
                return { ok: false, error: "anthropic search returned empty response" };
            }
            return { ok: true, value: text };
        }

        if (ctx.provider.id === "openrouter") {
            ctx.emitProgress?.([`querying openrouter:web_search · ${query}`]);
            try {
                const result = await runOpenRouterSearch({
                    provider: ctx.provider,
                    model: ctx.activeModel,
                    query,
                    maxResults: DEFAULT_LIMIT,
                    ...(normalized.allowed_domains
                        ? { allowedDomains: normalized.allowed_domains }
                        : {}),
                    ...(normalized.blocked_domains
                        ? { blockedDomains: normalized.blocked_domains }
                        : {}),
                    signal: ctx.signal,
                    sessionId: ctx.sessionId,
                    projectId: ctx.projectId,
                });
                if (result.text.length > 0) {
                    ctx.emitProgress?.([
                        `openrouter:web_search · ${result.citations.length} citations`,
                    ]);
                    return { ok: true, value: result.text };
                }
                ctx.emitProgress?.(["openrouter:web_search returned empty; falling back"]);
                return fallbackSearch(normalized, ctx, "openrouter:web_search returned empty");
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                ctx.emitProgress?.([`openrouter:web_search failed (${msg}); falling back`]);
                return fallbackSearch(normalized, ctx, msg);
            }
        }
    }

    return fallbackSearch(normalized, ctx, "no server-side web search on active provider");
};

export const WebSearchTool: Tool = {
    name: "WebSearch",
    description:
        "Search the web. Returns a markdown list of `- [title](url)`. " +
        "After answering with search results you MUST include a `Sources:` section with each cited URL as a markdown link. " +
        'Pass `engine: "fallback"` to skip the provider\'s built-in search (Brave→DuckDuckGo). ' +
        'If results look wrong or contain opaque redirect URLs (e.g. vertexaisearch.cloud.google.com/grounding-api-redirect/…), retry with `engine: "fallback"`. ' +
        "Follow up with WebFetch on selected results to read content.",
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["query"],
        properties: {
            query: { type: "string" },
            allowed_domains: { type: "array", items: { type: "string" } },
            blocked_domains: { type: "array", items: { type: "string" } },
            engine: {
                type: "string",
                enum: ["auto", "openrouter", "fallback"],
                description:
                    "auto (default): provider built-in if available, else Brave/DuckDuckGo. openrouter: force the OpenRouter server-side tool. fallback: force Brave/DuckDuckGo.",
            },
        },
    },
    execute,
};
