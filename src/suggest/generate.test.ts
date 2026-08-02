import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Config } from "../config/index.ts";
import type { Provider, ProviderEvent, ProviderInput } from "../providers/types.ts";
import * as usage from "../storage/usage.ts";
import { generateSuggestion } from "./generate.ts";
import { MAX_SUGGESTION_TOKENS } from "./suggestion.ts";

type UsageArgs = Parameters<typeof usage.appendUsageRecord>[0];

interface StubProvider extends Provider {
    readonly calls: ProviderInput[];
}

const makeProvider = (
    events: readonly ProviderEvent[],
    opts: { readonly throws?: boolean } = {},
): StubProvider => {
    const calls: ProviderInput[] = [];
    const provider: Provider = {
        id: "openrouter",
        capabilities: {
            promptCache: false,
            toolUse: true,
            vision: false,
            serverSideWebSearch: false,
        },
        async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
            calls.push(input);
            if (opts.throws) throw new Error("network down");
            for (const evt of events) yield evt;
        },
        async getContextSize() {
            return 100_000;
        },
    };
    return Object.assign(provider, { calls });
};

const textEvents = (text: string): readonly ProviderEvent[] => [
    { type: "text.delta", text },
    { type: "usage", usage: { inputTokens: 40, outputTokens: 6 } },
    { type: "stop", reason: "end_turn" },
];

const makeConfig = (extra: Record<string, unknown> = {}): Config =>
    ({
        defaultProvider: "openrouter",
        providers: {
            openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "YE_TEST_OR_KEY" },
        },
        defaultModel: { provider: "openrouter", model: "expensive/model", providerSort: "price" },
        ...extra,
    }) as unknown as Config;

const run = (provider: Provider, config: Config) =>
    generateSuggestion({
        config,
        activeProvider: provider,
        activeModel: "expensive/model",
        lastUserPrompt: "fix the login bug",
        lastAssistantText: "Fixed it in auth.ts.",
        sessionId: "s",
        projectId: "p",
    });

let usageCalls: UsageArgs[] = [];
let restoreUsage: () => void = () => {};

beforeEach(() => {
    usageCalls = [];
    const spy = spyOn(usage, "appendUsageRecord").mockImplementation(async (rec) => {
        usageCalls.push(rec);
    });
    restoreUsage = () => spy.mockRestore();
});

afterEach(() => {
    restoreUsage();
});

describe("generateSuggestion routing", () => {
    test("routes to cheapModel with reasoning off and records the suggestion call kind", async () => {
        const provider = makeProvider(textEvents("run the tests"));
        const out = await run(
            provider,
            makeConfig({ cheapModel: { provider: "openrouter", model: "cheap/model" } }),
        );
        expect(out).toBe("run the tests");
        expect(provider.calls[0]?.model).toBe("cheap/model");
        expect(provider.calls[0]?.providerOptions).toEqual({ reasoning: false });
        expect(usageCalls[0]?.model).toBe("cheap/model");
        expect(usageCalls[0]?.callKind).toBe("suggestion");
    });

    test("falls back to the active model, still with reasoning off", async () => {
        const provider = makeProvider(textEvents("run the tests"));
        await run(provider, makeConfig());
        expect(provider.calls[0]?.model).toBe("expensive/model");
        expect(provider.calls[0]?.providerOptions).toMatchObject({ reasoning: false });
        expect(usageCalls[0]?.model).toBe("expensive/model");
    });

    test("caps output tokens and sends only two messages", async () => {
        const provider = makeProvider(textEvents("run the tests"));
        await run(provider, makeConfig());
        const call = provider.calls[0];
        expect(call?.maxTokens).toBe(MAX_SUGGESTION_TOKENS);
        expect(call?.messages).toHaveLength(2);
        expect(call?.stream).toBe(false);
        expect(call?.tools).toBeUndefined();
    });

    test("normalises a chatty multi-line answer down to one line", async () => {
        const provider = makeProvider(
            textEvents('Sure! Here you go:\n"run the tests"\nOr commit instead.'),
        );
        expect(await run(provider, makeConfig())).toBe("Sure! Here you go:");
    });
});

describe("generateSuggestion silent failure", () => {
    test("returns null when the provider throws", async () => {
        const provider = makeProvider([], { throws: true });
        expect(await run(provider, makeConfig())).toBeNull();
    });

    test("returns null when the stream stops with an error", async () => {
        const provider = makeProvider([
            { type: "text.delta", text: "run the tests" },
            {
                type: "stop",
                reason: "error",
                error: { kind: "rate_limit", message: "429", retryable: true },
            },
        ]);
        expect(await run(provider, makeConfig())).toBeNull();
    });

    test("returns null when the model produced nothing usable", async () => {
        expect(await run(makeProvider(textEvents("   ")), makeConfig())).toBeNull();
        expect(await run(makeProvider(textEvents("")), makeConfig())).toBeNull();
    });

    test("returns the suggestion even when usage recording fails", async () => {
        restoreUsage();
        const spy = spyOn(usage, "appendUsageRecord").mockImplementation(async () => {
            throw new Error("disk full");
        });
        restoreUsage = () => spy.mockRestore();
        const provider = makeProvider(textEvents("run the tests"));
        expect(await run(provider, makeConfig())).toBe("run the tests");
    });
});
