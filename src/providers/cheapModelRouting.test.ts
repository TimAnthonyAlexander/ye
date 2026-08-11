import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Config } from "../config/index.ts";
import * as memoryIndex from "../memory/memoryIndex.ts";
import { ensureSelectedMemory } from "../memory/select.ts";
import { runSummarizeAndReplace } from "../pipeline/shapers/summarize.ts";
import type { SessionState } from "../pipeline/state.ts";
import { generateSessionTitle, resolveTitleCall } from "../storage/title.ts";
import * as usage from "../storage/usage.ts";
import { summarizePage } from "../tools/webFetch/summarize.ts";
import type { Message, Provider, ProviderEvent, ProviderInput } from "./types.ts";

type UsageArgs = Parameters<typeof usage.appendUsageRecord>[0];

interface StubProvider extends Provider {
    readonly calls: ProviderInput[];
}

const makeProvider = (text: string, id = "openrouter"): StubProvider => {
    const calls: ProviderInput[] = [];
    const provider: Provider = {
        id,
        capabilities: {
            promptCache: false,
            toolUse: true,
            vision: false,
            serverSideWebSearch: false,
        },
        async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
            calls.push(input);
            yield { type: "text.delta", text };
            yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
            yield { type: "stop", reason: "end_turn" };
        },
        async getContextSize() {
            return 100_000;
        },
    };
    return Object.assign(provider, { calls });
};

const CHEAP = { provider: "openrouter", model: "cheap/model" };

const makeConfig = (extra: Record<string, unknown> = {}): Config =>
    ({
        defaultProvider: "openrouter",
        providers: {
            openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "YE_TEST_OR_KEY" },
        },
        defaultModel: { provider: "openrouter", model: "expensive/model", providerSort: "price" },
        ...extra,
    }) as unknown as Config;

const userMsg = (n: number): Message => ({ role: "user", content: `u${n} ` + "x".repeat(40) });

const makeState = (): SessionState =>
    ({
        sessionId: "s",
        projectId: "p",
        projectRoot: "/tmp",
        mode: "AUTO",
        contextWindow: 1000,
        history: Array.from({ length: 20 }, (_, i) => userMsg(i)),
        sessionRules: [],
        denialTrail: null,
        compactedThisTurn: false,
        ghostWaitFiredThisPrompt: false,
        selectedMemory: [],
        turnState: { readFiles: new Map(), todos: [] },
    }) as unknown as SessionState;

const runShaperSummarize = (provider: Provider, config: Config) =>
    runSummarizeAndReplace(
        {
            state: makeState(),
            provider,
            config,
            model: "expensive/model",
            messages: [],
            budget: { maxTokens: 0, initialMaxTokens: 0, tokensFreedThisTurn: 0 },
        },
        { preserveRecent: 4, promptStyle: "auto-compact" },
    );

const webFetchArgs = (provider: Provider, config?: Config) => ({
    provider,
    model: "expensive/model",
    ...(config ? { config } : {}),
    url: "https://example.com",
    question: "what",
    content: "page body",
    signal: new AbortController().signal,
    sessionId: "s",
    projectId: "p",
});

let usageCalls: UsageArgs[] = [];
let restoreUsage: () => void = () => {};
let restoreIndex: () => void = () => {};

beforeEach(() => {
    usageCalls = [];
    const usageSpy = spyOn(usage, "appendUsageRecord").mockImplementation(async (rec) => {
        usageCalls.push(rec);
    });
    restoreUsage = () => usageSpy.mockRestore();
    const indexSpy = spyOn(memoryIndex, "parseMemoryIndex").mockResolvedValue([
        { path: "/tmp/ye-test-memory.md", title: "Notes", hook: "when testing" },
    ]);
    restoreIndex = () => indexSpy.mockRestore();
});

afterEach(() => {
    restoreUsage();
    restoreIndex();
});

describe("cheapModel unset (regression)", () => {
    test("the shaper summarizer uses the active model and its routing options", async () => {
        const provider = makeProvider("summary text");
        await runShaperSummarize(provider, makeConfig());
        expect(provider.calls[0]?.model).toBe("expensive/model");
        expect(provider.calls[0]?.providerOptions).toEqual({
            providerOrder: undefined,
            allowFallbacks: undefined,
            providerSort: "price",
        });
        expect(usageCalls[0]?.model).toBe("expensive/model");
        expect(usageCalls[0]?.callKind).toBe("summarize");
    });

    test("memory selection uses the active model", async () => {
        const provider = makeProvider("[]");
        await ensureSelectedMemory({
            projectId: "p",
            sessionId: "s",
            query: "how do shapers work",
            provider,
            config: makeConfig(),
        });
        expect(provider.calls[0]?.model).toBe("expensive/model");
        expect(usageCalls[0]?.callKind).toBe("memory");
    });

    test("titles keep the hardcoded per-provider picks", () => {
        const config = makeConfig();
        expect(resolveTitleCall(config, makeProvider("", "openrouter"))?.model).toBe(
            "~google/gemini-flash-latest",
        );
        expect(resolveTitleCall(config, makeProvider("", "anthropic"))?.model).toBe(
            "claude-haiku-4-5",
        );
        expect(resolveTitleCall(config, makeProvider("", "openai"))).toBeNull();
    });

    test("WebFetch uses the model the caller resolved", async () => {
        const provider = makeProvider("page summary");
        await summarizePage(webFetchArgs(provider, makeConfig()));
        expect(provider.calls[0]?.model).toBe("expensive/model");
        expect(usageCalls[0]?.callKind).toBe("webFetch");
    });

    test("WebFetch behaves identically when no config is supplied at all", async () => {
        const provider = makeProvider("page summary");
        await summarizePage(webFetchArgs(provider));
        expect(provider.calls[0]?.model).toBe("expensive/model");
        expect(usageCalls[0]?.model).toBe("expensive/model");
    });
});

describe("cheapModel set", () => {
    const config = () => makeConfig({ cheapModel: CHEAP });

    test("the shaper summarizer routes to the cheap model with reasoning off", async () => {
        const provider = makeProvider("summary text");
        await runShaperSummarize(provider, config());
        expect(provider.calls[0]?.model).toBe("cheap/model");
        expect(provider.calls[0]?.providerOptions).toEqual({ reasoning: false });
        expect(usageCalls[0]?.model).toBe("cheap/model");
        expect(usageCalls[0]?.callKind).toBe("summarize");
    });

    test("memory selection routes to the cheap model", async () => {
        const provider = makeProvider("[]");
        await ensureSelectedMemory({
            projectId: "p",
            sessionId: "s",
            query: "how do shapers work",
            provider,
            config: config(),
        });
        expect(provider.calls[0]?.model).toBe("cheap/model");
        expect(provider.calls[0]?.providerOptions).toEqual({ reasoning: false });
        expect(usageCalls[0]?.model).toBe("cheap/model");
        expect(usageCalls[0]?.callKind).toBe("memory");
    });

    test("titles route to the cheap model, including providers that had no pick", async () => {
        const provider = makeProvider("Fix login button", "openai");
        const cfg = makeConfig({ cheapModel: { provider: "openai", model: "cheap/model" } });
        const target = resolveTitleCall(cfg, provider);
        expect(target?.model).toBe("cheap/model");
        expect(target?.provider).toBe(provider);

        const title = await generateSessionTitle({
            provider,
            model: target?.model ?? "",
            userPrompt: "the login button does nothing",
            sessionId: "s",
            projectId: "p",
        });
        expect(title).toBe("Fix login button");
        expect(usageCalls[0]?.model).toBe("cheap/model");
        expect(usageCalls[0]?.callKind).toBe("title");
    });

    test("WebFetch routes to the cheap model", async () => {
        const provider = makeProvider("page summary");
        await summarizePage(webFetchArgs(provider, config()));
        expect(provider.calls[0]?.model).toBe("cheap/model");
        expect(usageCalls[0]?.model).toBe("cheap/model");
        expect(usageCalls[0]?.callKind).toBe("webFetch");
    });

    test("webTools.summarizeModel still wins for WebFetch", async () => {
        const provider = makeProvider("page summary");
        const cfg = makeConfig({
            cheapModel: CHEAP,
            webTools: { summarizeModel: "explicit/model" },
        });
        await summarizePage({ ...webFetchArgs(provider, cfg), model: "explicit/model" });
        expect(provider.calls[0]?.model).toBe("explicit/model");
        expect(usageCalls[0]?.callKind).toBe("webFetch");
    });

    test("an unbuildable cheap provider falls back to the active model", async () => {
        const provider = makeProvider("summary text");
        const cfg = makeConfig({
            cheapModel: { provider: "anthropic", model: "claude-haiku-4-5" },
            providers: {
                anthropic: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "YE_TEST_NO_KEY" },
            },
        });
        const outcome = await runShaperSummarize(provider, cfg);
        expect(outcome.result).toBe("applied");
        expect(provider.calls[0]?.model).toBe("expensive/model");
        expect(usageCalls[0]?.model).toBe("expensive/model");
    });
});
