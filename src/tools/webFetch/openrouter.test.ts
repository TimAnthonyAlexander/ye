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
    test("declares openrouter:web_fetch builtin and returns text", async () => {
        const provider = makeProvider([
            { type: "text.delta", text: "It says " },
            { type: "text.delta", text: "hello." },
            { type: "stop", reason: "end_turn" },
        ]);
        const text = await runOpenRouterFetch({ provider, ...baseArgs });
        expect(text).toBe("It says hello.");

        const builtins = provider.calls[0]?.providerOptions?.["builtinTools"] as unknown as Array<
            Record<string, unknown>
        >;
        expect(builtins).toEqual([{ type: "openrouter:web_fetch" }]);

        // Prompt should include the URL and the question
        const userMsg = provider.calls[0]?.messages[0];
        expect(userMsg?.role).toBe("user");
        expect(typeof userMsg?.content).toBe("string");
        expect(userMsg?.content).toContain("https://example.com/article");
        expect(userMsg?.content).toContain("what does this say?");
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
