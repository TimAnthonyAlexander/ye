import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import { checkDomain } from "../webShared/domainGate.ts";
import { cacheGet, cacheSet } from "./cache.ts";
import { fetchUrl } from "./fetch.ts";
import { htmlToMarkdown } from "./htmlToMarkdown.ts";
import { normalizeUrl } from "./normalize.ts";
import { runOpenRouterFetch } from "./openrouter.ts";
import { summarizePage } from "./summarize.ts";

interface WebFetchArgs {
    readonly url: string;
    readonly prompt: string;
}

const DEFAULT_CACHE_TTL = 15 * 60 * 1000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 100_000;

const truncateContent = (s: string, max: number): string =>
    s.length > max ? `${s.slice(0, max)}\n…(truncated, ${s.length - max} more chars)` : s;

const runLocalFetch = async (
    url: string,
    host: string,
    prompt: string,
    ctx: ToolContext,
): Promise<ToolResult<string>> => {
    const cfg = ctx.config.webTools ?? {};
    const ttl = cfg.cacheTtlMs ?? DEFAULT_CACHE_TTL;
    const maxBytes = cfg.maxFetchBytes ?? DEFAULT_MAX_BYTES;
    const maxChars = cfg.maxContentChars ?? DEFAULT_MAX_CHARS;

    let content = cacheGet(url);
    if (content !== null) {
        ctx.emitProgress?.([`cache hit (${content.length.toLocaleString()} chars)`]);
    } else {
        ctx.emitProgress?.([`fetching ${host}`]);
        const fetched = await fetchUrl({
            url,
            maxBytes,
            signal: ctx.signal,
        });
        if (!fetched.ok) return fetched;
        if (fetched.kind === "redirect") {
            ctx.emitProgress?.([`cross-host redirect → ${fetched.redirectTo}`]);
            return {
                ok: true,
                value:
                    `REDIRECT DETECTED: ${fetched.redirectTo}\n` +
                    "Call WebFetch again with this URL if you trust the new host.",
            };
        }
        ctx.emitProgress?.([
            `received ${fetched.content.length.toLocaleString()} chars (${fetched.kind}), parsing`,
        ]);
        const raw = fetched.kind === "html" ? htmlToMarkdown(fetched.content) : fetched.content;
        content = truncateContent(raw, maxChars);
        cacheSet(url, content, ttl);
    }

    const summarizerModel = cfg.summarizeModel ?? ctx.activeModel;
    ctx.emitProgress?.([`summarising via ${summarizerModel}`]);
    const summary = await summarizePage({
        provider: ctx.provider,
        model: summarizerModel,
        url,
        question: prompt,
        content,
        signal: ctx.signal,
        sessionId: ctx.sessionId,
        projectId: ctx.projectId,
    });

    if (summary.length === 0) {
        return { ok: false, error: "summariser returned an empty response" };
    }
    return { ok: true, value: summary };
};

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<WebFetchArgs>(rawArgs, WebFetchTool.schema);
    if (!v.ok) return v;
    const { url: rawUrl, prompt } = v.value;

    if (prompt.trim().length === 0) {
        return { ok: false, error: "prompt is empty" };
    }

    ctx.emitProgress?.(["normalising URL"]);
    const normalised = normalizeUrl(rawUrl);
    if (!normalised.ok) return normalised;

    const gate = checkDomain({
        host: normalised.host,
        ...(ctx.config.webTools ? { config: ctx.config.webTools } : {}),
    });
    if (!gate.ok) return { ok: false, error: gate.reason };

    if (ctx.provider.id === "openrouter") {
        ctx.emitProgress?.([`fetching via openrouter:web_fetch · ${normalised.host}`]);
        try {
            const cfg = ctx.config.webTools ?? {};
            const text = await runOpenRouterFetch({
                provider: ctx.provider,
                model: ctx.activeModel,
                url: normalised.url,
                question: prompt,
                ...(cfg.allowedDomains ? { allowedDomains: cfg.allowedDomains } : {}),
                ...(cfg.blockedDomains ? { blockedDomains: cfg.blockedDomains } : {}),
                signal: ctx.signal,
                sessionId: ctx.sessionId,
                projectId: ctx.projectId,
            });
            if (text.length > 0) {
                return { ok: true, value: text };
            }
            ctx.emitProgress?.([
                "openrouter:web_fetch returned empty; falling back to local fetch",
            ]);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.emitProgress?.([
                `openrouter:web_fetch failed (${msg}); falling back to local fetch`,
            ]);
        }
    }

    return runLocalFetch(normalised.url, normalised.host, prompt, ctx);
};

export const WebFetchTool: Tool = {
    name: "WebFetch",
    description:
        "Fetch a URL and answer a question about its contents. The page is summarised by a small model — you never see raw HTML. " +
        "HTTP auto-upgrades to HTTPS. 15-min cache by URL. Cross-host redirects fail closed: re-call with the new URL if you trust it. " +
        "For GitHub URLs prefer `gh` (gh pr view, gh issue view, gh api) via Bash.",
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["url", "prompt"],
        properties: {
            url: { type: "string" },
            prompt: { type: "string" },
        },
    },
    execute,
};
