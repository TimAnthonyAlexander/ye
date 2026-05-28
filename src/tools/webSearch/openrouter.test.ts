import { describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent, ProviderInput } from "../../providers/index.ts";
import { runOpenRouterSearch } from "./openrouter.ts";

interface StubProvider extends Provider {
    readonly calls: ProviderInput[];
}

const makeProvider = (events: readonly ProviderEvent[]): StubProvider => {
    const calls: ProviderInput[] = [];
    const provider: Provider = {
        id: "openrouter",
        capabilities: {
            promptCache: false,
            toolUse: true,
            vision: false,
            serverSideWebSearch: true,
        },
        async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
            calls.push(input);
            for (const e of events) yield e;
        },
        async getContextSize() {
            return 100_000;
        },
    };
    return Object.assign(provider, { calls });
};

const baseArgs = {
    model: "x-ai/grok-foo",
    query: "what is bun",
    signal: new AbortController().signal,
    sessionId: "s",
    projectId: "p",
};

describe("runOpenRouterSearch", () => {
    test("declares openrouter:web_search builtin and forces reasoning exclude", async () => {
        const provider = makeProvider([
            { type: "text.delta", text: "- [A](https://a.example)" },
            { type: "stop", reason: "end_turn" },
        ]);
        await runOpenRouterSearch({ provider, ...baseArgs, maxResults: 10 });

        const opts = provider.calls[0]?.providerOptions as Record<string, unknown>;
        const builtins = opts["builtinTools"] as Array<Record<string, unknown>>;
        expect(builtins).toEqual([{ type: "openrouter:web_search", max_results: 10 }]);
        expect(opts["reasoning"]).toEqual({ exclude: true });
    });

    test("citations from engine take precedence over the model's typed text", async () => {
        const provider = makeProvider([
            // Model leaks Gemini-style grounding-redirect URLs as text…
            {
                type: "text.delta",
                text: "- [lairner](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA)",
            },
            // …but the engine returned the resolved URLs as citations.
            {
                type: "citations",
                citations: [
                    { url: "https://lairner.app", title: "lairner — language learning" },
                    {
                        url: "https://apps.apple.com/us/app/lairner/id6446864115",
                        title: "App Store",
                    },
                ],
            },
            { type: "stop", reason: "end_turn" },
        ]);

        const result = await runOpenRouterSearch({ provider, ...baseArgs });
        expect(result.citations).toHaveLength(2);
        expect(result.text).toContain("lairner.app");
        expect(result.text).not.toContain("vertexaisearch");
        expect(result.text.split("\n")).toEqual([
            "- [lairner — language learning](https://lairner.app)",
            "- [App Store](https://apps.apple.com/us/app/lairner/id6446864115)",
        ]);
    });

    test("falls back to text when no citations event, stripping leading 'thought\\n…' CoT leak", async () => {
        const provider = makeProvider([
            {
                type: "text.delta",
                text: "thought\nLet me pick the best results from the search tool output.\n- [A](https://a.example)\n- [B](https://b.example)",
            },
            { type: "stop", reason: "end_turn" },
        ]);
        const result = await runOpenRouterSearch({ provider, ...baseArgs });
        expect(result.citations).toEqual([]);
        expect(result.text.startsWith("- [A]")).toBe(true);
        expect(result.text).not.toMatch(/thought/i);
    });

    test("returns plain text when there's no CoT leak and no citations", async () => {
        const provider = makeProvider([
            { type: "text.delta", text: "- [Only](https://only.example)" },
            { type: "stop", reason: "end_turn" },
        ]);
        const result = await runOpenRouterSearch({ provider, ...baseArgs });
        expect(result.text).toBe("- [Only](https://only.example)");
    });

    test("forwards allowed_domains and excluded_domains (note: excluded, not blocked)", async () => {
        const provider = makeProvider([{ type: "stop", reason: "end_turn" }]);
        await runOpenRouterSearch({
            provider,
            ...baseArgs,
            allowedDomains: ["docs.python.org"],
            blockedDomains: ["pinterest.com"],
        });
        const builtins = provider.calls[0]?.providerOptions?.["builtinTools"] as unknown as Array<
            Record<string, unknown>
        >;
        expect(builtins[0]?.["allowed_domains"]).toEqual(["docs.python.org"]);
        expect(builtins[0]?.["excluded_domains"]).toEqual(["pinterest.com"]);
        expect(builtins[0]?.["blocked_domains"]).toBeUndefined();
    });

    test("throws on stop reason=error", async () => {
        const provider = makeProvider([
            {
                type: "stop",
                reason: "error",
                error: { kind: "server", message: "boom", retryable: false },
            },
        ]);
        await expect(runOpenRouterSearch({ provider, ...baseArgs })).rejects.toThrow(/boom/);
    });
});
