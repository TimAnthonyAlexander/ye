import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import { runAnthropicSearch } from "./anthropic.ts";
import { runDuckDuckGoSearch } from "./duckduckgo.ts";

interface WebSearchArgs {
    readonly query: string;
    readonly allowed_domains?: readonly string[];
    readonly blocked_domains?: readonly string[];
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LIMIT = 10;

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<WebSearchArgs>(rawArgs, WebSearchTool.schema);
    if (!v.ok) return v;
    const query = v.value.query.trim();
    if (query.length < 2) return { ok: false, error: "query must be at least 2 chars" };

    const cfg = ctx.config.webTools ?? {};

    if (ctx.provider.capabilities.serverSideWebSearch) {
        ctx.emitProgress?.([`querying anthropic web_search · ${query}`]);
        const text = await runAnthropicSearch({
            provider: ctx.provider,
            model: ctx.activeModel,
            query,
            ...(v.value.allowed_domains ? { allowedDomains: v.value.allowed_domains } : {}),
            ...(v.value.blocked_domains ? { blockedDomains: v.value.blocked_domains } : {}),
            signal: ctx.signal,
        });
        if (text.length === 0) {
            return { ok: false, error: "anthropic search returned empty response" };
        }
        return { ok: true, value: text };
    }

    const fallback = cfg.searchFallback ?? "duckduckgo";
    if (fallback === "off") {
        return {
            ok: false,
            error: 'WebSearch unavailable: switch to the Anthropic provider via /provider, or set webTools.searchFallback to "duckduckgo" in ~/.ye/config.json.',
        };
    }

    ctx.emitProgress?.([`querying duckduckgo · ${query}`]);
    const ddg = await runDuckDuckGoSearch({
        query,
        ...(v.value.allowed_domains ? { allowedDomains: v.value.allowed_domains } : {}),
        ...(v.value.blocked_domains ? { blockedDomains: v.value.blocked_domains } : {}),
        maxBytes: cfg.maxFetchBytes ?? DEFAULT_MAX_BYTES,
        limit: DEFAULT_LIMIT,
        ...(cfg ? { config: cfg } : {}),
        signal: ctx.signal,
    });
    if (!ddg.ok) return ddg;

    ctx.emitProgress?.([`got ${ddg.results.length} results`]);
    const lines = ddg.results.map((r) => `- [${r.title}](${r.url})`);
    return { ok: true, value: lines.join("\n") };
};

export const WebSearchTool: Tool = {
    name: "WebSearch",
    description:
        "Search the web. Returns title + URL only — no snippets. Follow up with WebFetch on selected results to read content. " +
        "After answering with search results you MUST include a `Sources:` section with each cited URL as a markdown link.",
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["query"],
        properties: {
            query: { type: "string" },
            allowed_domains: { type: "array", items: { type: "string" } },
            blocked_domains: { type: "array", items: { type: "string" } },
        },
    },
    execute,
};
