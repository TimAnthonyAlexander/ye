import { describe, expect, test } from "bun:test";
import type { Config } from "../../config/index.ts";
import type { Provider, ProviderEvent, ProviderInput } from "../../providers/index.ts";
import type { ToolContext } from "../types.ts";
import { WebSearchTool } from "./index.ts";

const makeProvider = (
    id: string,
    events: readonly ProviderEvent[],
    serverSide: boolean,
): { provider: Provider; calls: ProviderInput[] } => {
    const calls: ProviderInput[] = [];
    const provider: Provider = {
        id,
        capabilities: {
            promptCache: false,
            toolUse: true,
            vision: false,
            serverSideWebSearch: serverSide,
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

describe("WebSearchTool dispatch — openrouter", () => {
    test("openrouter provider with text result returns it without fallback", async () => {
        const { provider, calls } = makeProvider(
            "openrouter",
            [
                { type: "text.delta", text: "- [A](https://a.example)" },
                { type: "stop", reason: "end_turn" },
            ],
            true,
        );
        const r = await WebSearchTool.execute({ query: "bun runtime" }, makeCtx(provider));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toContain("[A](https://a.example)");
        expect(calls).toHaveLength(1);
        const builtins = calls[0]?.providerOptions?.["builtinTools"] as unknown as Array<
            Record<string, unknown>
        >;
        expect(builtins?.[0]?.["type"]).toBe("openrouter:web_search");
    });

    test("openrouter error → searchFallback off → returns error mentioning the OR failure", async () => {
        const { provider } = makeProvider(
            "openrouter",
            [
                {
                    type: "stop",
                    reason: "error",
                    error: { kind: "server", message: "OR is down", retryable: false },
                },
            ],
            true,
        );
        const cfg: Config = { ...baseConfig, webTools: { searchFallback: "off" } };
        const r = await WebSearchTool.execute({ query: "bun runtime" }, makeCtx(provider, cfg));
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toMatch(/OR is down/);
            expect(r.error).toMatch(/searchFallback/);
        }
    });

    test("non-server provider, searchFallback off → returns error", async () => {
        const { provider } = makeProvider("ollama", [], false);
        const cfg: Config = { ...baseConfig, webTools: { searchFallback: "off" } };
        const r = await WebSearchTool.execute({ query: "bun runtime" }, makeCtx(provider, cfg));
        expect(r.ok).toBe(false);
    });

    test("short query rejected", async () => {
        const { provider } = makeProvider("openrouter", [], true);
        const r = await WebSearchTool.execute({ query: "x" }, makeCtx(provider));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/at least 2/);
    });
});
