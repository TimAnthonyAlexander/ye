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
        // One call total — the OR builtin call. No second call for local-fetch summariser.
        expect(calls).toHaveLength(1);
        const builtins = calls[0]?.providerOptions?.["builtinTools"] as unknown as Array<
            Record<string, unknown>
        >;
        expect(builtins?.[0]?.["type"]).toBe("openrouter:web_fetch");
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
