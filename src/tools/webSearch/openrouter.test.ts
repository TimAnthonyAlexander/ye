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
    test("declares openrouter:web_search builtin tool with max_results and returns text", async () => {
        const provider = makeProvider([
            { type: "text.delta", text: "- [A](https://a.example)\n" },
            { type: "text.delta", text: "- [B](https://b.example)" },
            { type: "stop", reason: "end_turn" },
        ]);

        const text = await runOpenRouterSearch({ provider, ...baseArgs, maxResults: 10 });
        expect(text).toBe("- [A](https://a.example)\n- [B](https://b.example)");
        expect(provider.calls).toHaveLength(1);

        const builtins = provider.calls[0]?.providerOptions?.["builtinTools"] as unknown as Array<
            Record<string, unknown>
        >;
        expect(builtins).toEqual([{ type: "openrouter:web_search", max_results: 10 }]);
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
