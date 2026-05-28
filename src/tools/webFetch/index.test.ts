import { describe, expect, test } from "bun:test";
import type { Config } from "../../config/index.ts";
import type { Provider, ProviderEvent, ProviderInput } from "../../providers/index.ts";
import type { ToolContext } from "../types.ts";
import { WebFetchTool } from "./index.ts";

const makeProvider = (
    id: string,
    events: readonly ProviderEvent[],
): { provider: Provider; calls: ProviderInput[] } => {
    const calls: ProviderInput[] = [];
    const provider: Provider = {
        id,
        capabilities: {
            promptCache: false,
            toolUse: true,
            vision: false,
            serverSideWebSearch: id === "openrouter" || id === "anthropic",
        },
        async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
            calls.push(input);
            for (const e of events) yield e;
        },
        async getContextSize() {
            return 100_000;
        },
    };
    return { provider, calls };
};

const baseConfig: Config = {
    defaultProvider: "openrouter",
    providers: { openrouter: { baseUrl: "https://example.test", apiKeyEnv: "OR_KEY" } },
    defaultModel: { provider: "openrouter", model: "x-ai/grok-foo" },
};

const makeCtx = (provider: Provider, cfg: Config = baseConfig): ToolContext => ({
    cwd: "/tmp",
    signal: new AbortController().signal,
    sessionId: "s",
    projectId: "p",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider,
    config: cfg,
    activeModel: "x-ai/grok-foo",
    log: () => {},
});

describe("WebFetchTool dispatch — openrouter", () => {
    test("openrouter provider returns text → no local fetch attempted", async () => {
        const { provider, calls } = makeProvider("openrouter", [
            { type: "text.delta", text: "The page is about cats." },
            { type: "stop", reason: "end_turn" },
        ]);
        const r = await WebFetchTool.execute(
            { url: "https://example.com/cats", prompt: "what's the page about?" },
            makeCtx(provider),
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe("The page is about cats.");
        expect(calls).toHaveLength(1);
        const builtins = calls[0]?.providerOptions?.["builtinTools"] as unknown as Array<
            Record<string, unknown>
        >;
        expect(builtins?.[0]?.["type"]).toBe("openrouter:web_fetch");
    });

    // The local-fetch path also calls provider.stream (for the summariser),
    // so we identify an OR side-call by its signature: providerOptions
    // contains a `builtinTools` entry of type "openrouter:web_fetch".
    const sawOpenRouterFetch = (calls: readonly ProviderInput[]): boolean =>
        calls.some((c) => {
            const builtins = c.providerOptions?.["builtinTools"];
            if (!Array.isArray(builtins)) return false;
            return builtins.some(
                (t) =>
                    typeof t === "object" &&
                    t !== null &&
                    (t as { type?: unknown }).type === "openrouter:web_fetch",
            );
        });

    test("engine=local skips OR (no openrouter:web_fetch side-call)", async () => {
        const { provider, calls } = makeProvider("openrouter", []);
        await WebFetchTool.execute(
            {
                url: "https://nonexistent.invalid.example/x",
                prompt: "p",
                engine: "local",
            },
            makeCtx(provider),
        );
        expect(sawOpenRouterFetch(calls)).toBe(false);
    });

    test("auto + known-difficult host (news.ycombinator.com) → bypasses OR", async () => {
        const { provider, calls } = makeProvider("openrouter", []);
        await WebFetchTool.execute(
            {
                url: "https://news.ycombinator.com/item?id=39371728",
                prompt: "what is this thread about?",
            },
            makeCtx(provider),
        );
        expect(sawOpenRouterFetch(calls)).toBe(false);
    });

    test("auto + github.com → bypasses OR", async () => {
        const { provider, calls } = makeProvider("openrouter", []);
        await WebFetchTool.execute(
            { url: "https://github.com/oven-sh/bun", prompt: "what is bun?" },
            makeCtx(provider),
        );
        expect(sawOpenRouterFetch(calls)).toBe(false);
    });

    test("auto + subdomain of bypass host (gist.github.com) → bypasses OR", async () => {
        const { provider, calls } = makeProvider("openrouter", []);
        await WebFetchTool.execute(
            { url: "https://gist.github.com/x/y", prompt: "what's here?" },
            makeCtx(provider),
        );
        expect(sawOpenRouterFetch(calls)).toBe(false);
    });

    test("engine=openrouter on bypass host overrides the bypass", async () => {
        const { provider, calls } = makeProvider("openrouter", [
            { type: "text.delta", text: "From HN: a thread about lairner." },
            { type: "stop", reason: "end_turn" },
        ]);
        const r = await WebFetchTool.execute(
            {
                url: "https://news.ycombinator.com/item?id=39371728",
                prompt: "what is this thread about?",
                engine: "openrouter",
            },
            makeCtx(provider),
        );
        expect(r.ok).toBe(true);
        expect(calls).toHaveLength(1);
    });

    test("engine=openrouter on error returns the OR error verbatim (no transparent fallback)", async () => {
        const { provider } = makeProvider("openrouter", [
            {
                type: "stop",
                reason: "error",
                error: { kind: "server", message: "503", retryable: false },
            },
        ]);
        const r = await WebFetchTool.execute(
            {
                url: "https://example.com/x",
                prompt: "p",
                engine: "openrouter",
            },
            makeCtx(provider),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toMatch(/openrouter:web_fetch failed/);
            expect(r.error).toMatch(/engine="local"/);
        }
    });

    test("empty prompt rejected", async () => {
        const { provider } = makeProvider("openrouter", []);
        const r = await WebFetchTool.execute(
            { url: "https://example.com", prompt: "   " },
            makeCtx(provider),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/prompt is empty/);
    });

    test("invalid URL rejected before provider call", async () => {
        const { provider, calls } = makeProvider("openrouter", []);
        const r = await WebFetchTool.execute(
            { url: "javascript:alert(1)", prompt: "x" },
            makeCtx(provider),
        );
        expect(r.ok).toBe(false);
        expect(calls).toHaveLength(0);
    });
});
