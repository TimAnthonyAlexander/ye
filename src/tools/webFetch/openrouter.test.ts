import { describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent, ProviderInput } from "../../providers/index.ts";
import { runOpenRouterFetch } from "./openrouter.ts";

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
    url: "https://example.com/article",
    question: "what does this say?",
    signal: new AbortController().signal,
    sessionId: "s",
    projectId: "p",
};

describe("runOpenRouterFetch", () => {
    test("declares openrouter:web_fetch and forces reasoning exclude", async () => {
        const provider = makeProvider([
            { type: "text.delta", text: "The page is about cats." },
            { type: "stop", reason: "end_turn" },
        ]);
        const result = await runOpenRouterFetch({ provider, ...baseArgs });
        expect(result.text).toBe("The page is about cats.");

        const opts = provider.calls[0]?.providerOptions as Record<string, unknown>;
        expect((opts["builtinTools"] as Array<Record<string, unknown>>)[0]).toEqual({
            type: "openrouter:web_fetch",
        });
        expect(opts["reasoning"]).toEqual({ exclude: true });

        const userMsg = provider.calls[0]?.messages[0];
        expect(typeof userMsg?.content).toBe("string");
        expect(userMsg?.content).toContain("https://example.com/article");
        expect(userMsg?.content).toContain("what does this say?");
    });

    test("appends Sources section when citations are present", async () => {
        const provider = makeProvider([
            { type: "text.delta", text: "Cats are mammals." },
            {
                type: "citations",
                citations: [{ url: "https://example.com/article", title: "Cats 101" }],
            },
            { type: "stop", reason: "end_turn" },
        ]);
        const result = await runOpenRouterFetch({ provider, ...baseArgs });
        expect(result.text).toBe(
            "Cats are mammals.\n\nSources:\n- [Cats 101](https://example.com/article)",
        );
        expect(result.citations).toHaveLength(1);
    });

    test("strips leading 'thought\\n…' CoT leak before the answer", async () => {
        const provider = makeProvider([
            {
                type: "text.delta",
                text: "thought\nLet me read the page carefully.\n\nThe page describes a recipe.",
            },
            { type: "stop", reason: "end_turn" },
        ]);
        const result = await runOpenRouterFetch({ provider, ...baseArgs });
        expect(result.text).toBe("The page describes a recipe.");
    });

    test("forwards max_content_tokens, allowed_domains, blocked_domains", async () => {
        const provider = makeProvider([{ type: "stop", reason: "end_turn" }]);
        await runOpenRouterFetch({
            provider,
            ...baseArgs,
            maxContentTokens: 5000,
            allowedDomains: ["example.com"],
            blockedDomains: ["evil.test"],
        });
        const builtins = provider.calls[0]?.providerOptions?.["builtinTools"] as unknown as Array<
            Record<string, unknown>
        >;
        expect(builtins[0]).toEqual({
            type: "openrouter:web_fetch",
            max_content_tokens: 5000,
            allowed_domains: ["example.com"],
            blocked_domains: ["evil.test"],
        });
    });

    test("throws on stop reason=error", async () => {
        const provider = makeProvider([
            {
                type: "stop",
                reason: "error",
                error: { kind: "server", message: "504 gateway", retryable: false },
            },
        ]);
        await expect(runOpenRouterFetch({ provider, ...baseArgs })).rejects.toThrow(/504/);
    });
});
