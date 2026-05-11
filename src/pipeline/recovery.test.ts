import { describe, expect, test } from "bun:test";
import type { Config } from "../config/index.ts";
import type { Provider, ProviderError, ProviderEvent, ProviderInput } from "../providers/index.ts";
import type { Event } from "./events.ts";
import { runModelCallWithRecovery } from "./recovery.ts";
import { newShapingFlags, newTurnState, type SessionState } from "./state.ts";

const baseConfig: Config = {
    defaultProvider: "test",
    providers: { test: { baseUrl: "https://example.test", apiKeyEnv: "TEST_KEY" } },
    defaultModel: { provider: "test", model: "model-a" },
    recovery: {
        maxRetries: 3,
        backoffBaseMs: 1,
        backoffMaxMs: 1,
        rateLimitMaxRetries: 10,
        rateLimitBackoffBaseMs: 1,
        rateLimitBackoffMaxMs: 1,
    },
};

const mkState = (): SessionState => ({
    sessionId: "s",
    projectId: "p",
    projectRoot: "/tmp",
    mode: "AUTO",
    contextWindow: 100_000,
    history: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
    ],
    sessionRules: [],
    denialTrail: null,
    compactedThisTurn: false,
    shapingFlags: newShapingFlags(),
    globalTurnIndex: 0,
    selectedMemory: null,
    headless: false,
    turnState: newTurnState(),
});

interface ScriptedAttempt {
    readonly events: readonly ProviderEvent[];
    // When set, call records the input on each attempt for assertions.
    readonly tag?: string;
}

const scriptedProvider = (attempts: ScriptedAttempt[], log: ProviderInput[]): Provider => {
    let i = 0;
    return {
        id: "test",
        capabilities: {
            promptCache: false,
            toolUse: true,
            vision: false,
            serverSideWebSearch: false,
        },
        async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
            log.push(input);
            const cur = attempts[Math.min(i, attempts.length - 1)];
            i += 1;
            if (!cur) return;
            for (const evt of cur.events) yield evt;
        },
        async getContextSize(): Promise<number> {
            return 100_000;
        },
    };
};

const collect = async (
    gen: AsyncGenerator<Event, unknown>,
): Promise<{ events: Event[]; out: unknown }> => {
    const events: Event[] = [];
    while (true) {
        const next = await gen.next();
        if (next.done) return { events, out: next.value };
        events.push(next.value);
    }
};

const runError = (kind: ProviderError["kind"]): ProviderEvent => ({
    type: "stop",
    reason: "error",
    error: { kind, message: kind, retryable: true },
});

const runText = (text: string): ProviderEvent[] => [
    { type: "text.delta", text },
    { type: "stop", reason: "end_turn" },
];

describe("runModelCallWithRecovery", () => {
    test("success on first attempt — no retries", async () => {
        const log: ProviderInput[] = [];
        const provider = scriptedProvider([{ events: runText("ok") }], log);

        const gen = runModelCallWithRecovery({
            state: mkState(),
            config: baseConfig,
            initialProvider: provider,
            initialModel: "model-a",
            budget: { maxTokens: 4000, initialMaxTokens: 4000, tokensFreedThisTurn: 0 },
            initialMessages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
            providerOptions: {},
        });

        const { events, out } = (await collect(gen)) as {
            events: Event[];
            out: { result: { text: string; stopReason: string } };
        };

        expect(out.result.text).toBe("ok");
        expect(out.result.stopReason).toBe("end_turn");
        expect(log.length).toBe(1);
        expect(events.some((e) => e.type === "recovery.retry")).toBe(false);
    });

    test("retries rate_limit then succeeds", async () => {
        const log: ProviderInput[] = [];
        const provider = scriptedProvider(
            [{ events: [runError("rate_limit")] }, { events: runText("ok-after-retry") }],
            log,
        );

        const gen = runModelCallWithRecovery({
            state: mkState(),
            config: baseConfig,
            initialProvider: provider,
            initialModel: "model-a",
            budget: { maxTokens: 4000, initialMaxTokens: 4000, tokensFreedThisTurn: 0 },
            initialMessages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
            providerOptions: {},
        });

        const { events, out } = (await collect(gen)) as {
            events: Event[];
            out: { result: { text: string; stopReason: string } };
        };

        expect(out.result.text).toBe("ok-after-retry");
        expect(log.length).toBe(2);
        const retries = events.filter((e) => e.type === "recovery.retry");
        expect(retries.length).toBe(1);
    });

    test("non-retryable auth error surfaces immediately", async () => {
        const log: ProviderInput[] = [];
        const provider = scriptedProvider(
            [
                {
                    events: [
                        {
                            type: "stop",
                            reason: "error",
                            error: { kind: "auth", message: "401", retryable: false },
                        },
                    ],
                },
            ],
            log,
        );

        const gen = runModelCallWithRecovery({
            state: mkState(),
            config: baseConfig,
            initialProvider: provider,
            initialModel: "model-a",
            budget: { maxTokens: 4000, initialMaxTokens: 4000, tokensFreedThisTurn: 0 },
            initialMessages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
            providerOptions: {},
        });

        const { events, out } = (await collect(gen)) as {
            events: Event[];
            out: { result: { stopReason: string } };
        };

        expect(out.result.stopReason).toBe("error");
        expect(log.length).toBe(1);
        expect(events.some((e) => e.type === "recovery.retry")).toBe(false);
    });

    test("does not retry once text was emitted", async () => {
        const log: ProviderInput[] = [];
        const provider = scriptedProvider(
            [
                {
                    events: [{ type: "text.delta", text: "partial" }, runError("server")],
                },
            ],
            log,
        );

        const gen = runModelCallWithRecovery({
            state: mkState(),
            config: baseConfig,
            initialProvider: provider,
            initialModel: "model-a",
            budget: { maxTokens: 4000, initialMaxTokens: 4000, tokensFreedThisTurn: 0 },
            initialMessages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
            providerOptions: {},
        });

        const { events, out } = (await collect(gen)) as {
            events: Event[];
            out: { result: { text: string; stopReason: string } };
        };

        // Content was emitted, so even though server-error is retryable in
        // principle, the recovery layer doesn't retry — replay would duplicate.
        expect(out.result.text).toBe("partial");
        expect(out.result.stopReason).toBe("error");
        expect(log.length).toBe(1);
        expect(events.filter((e) => e.type === "recovery.retry").length).toBe(0);
    });

    test("stream_error switches to non-streaming on retry (free retry, no attempt bump)", async () => {
        const log: ProviderInput[] = [];
        const provider = scriptedProvider(
            [{ events: [runError("stream_error")] }, { events: runText("batched-ok") }],
            log,
        );

        const gen = runModelCallWithRecovery({
            state: mkState(),
            config: baseConfig,
            initialProvider: provider,
            initialModel: "model-a",
            budget: { maxTokens: 4000, initialMaxTokens: 4000, tokensFreedThisTurn: 0 },
            initialMessages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
            providerOptions: {},
        });

        const { events, out } = (await collect(gen)) as {
            events: Event[];
            out: { result: { text: string; stopReason: string } };
        };

        expect(out.result.text).toBe("batched-ok");
        expect(log.length).toBe(2);
        // First call was streaming default; second call was stream:false.
        expect(log[0]?.stream === false).toBe(false);
        expect(log[1]?.stream).toBe(false);
        const retries = events.filter((e) => e.type === "recovery.retry");
        expect(retries.length).toBe(1);
        expect((retries[0] as { action?: string }).action).toBe("non_streaming");
    });

    test("max_tokens_invalid lowers maxTokens and retries", async () => {
        const log: ProviderInput[] = [];
        const provider = scriptedProvider(
            [{ events: [runError("max_tokens_invalid")] }, { events: runText("ok") }],
            log,
        );

        const gen = runModelCallWithRecovery({
            state: mkState(),
            config: baseConfig,
            initialProvider: provider,
            initialModel: "model-a",
            budget: { maxTokens: 8000, initialMaxTokens: 8000, tokensFreedThisTurn: 0 },
            initialMessages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
            providerOptions: {},
        });

        const { events, out } = (await collect(gen)) as {
            events: Event[];
            out: { result: { text: string } };
        };

        expect(out.result.text).toBe("ok");
        expect(log[0]?.maxTokens).toBe(8000);
        expect(log[1]?.maxTokens).toBe(4000);
        const retry = events.find((e) => e.type === "recovery.retry");
        expect(retry).toBeDefined();
        expect((retry as { action?: string }).action).toBe("lowered_max_tokens");
    });

    test("falls back to configured fallback model after persistent errors", async () => {
        const log: ProviderInput[] = [];
        const provider = scriptedProvider(
            [
                { events: [runError("overloaded")] },
                { events: [runError("overloaded")] },
                { events: runText("from-fallback") },
            ],
            log,
        );

        const cfg: Config = {
            ...baseConfig,
            recovery: {
                ...baseConfig.recovery,
                fallbackModel: { provider: "test", model: "model-b" },
            },
        };

        const gen = runModelCallWithRecovery({
            state: mkState(),
            config: cfg,
            initialProvider: provider,
            initialModel: "model-a",
            budget: { maxTokens: 4000, initialMaxTokens: 4000, tokensFreedThisTurn: 0 },
            initialMessages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
            providerOptions: {},
        });

        const { events, out } = (await collect(gen)) as {
            events: Event[];
            out: {
                result: { text: string };
                finalModel: string;
            };
        };

        expect(out.result.text).toBe("from-fallback");
        expect(out.finalModel).toBe("model-b");
        const fallback = events.find(
            (e) =>
                e.type === "recovery.retry" &&
                (e as { action?: string }).action === "fallback_model",
        );
        expect(fallback).toBeDefined();
    });

    test("rate_limit retries up to 10 times independent of general maxRetries", async () => {
        const log: ProviderInput[] = [];
        const provider = scriptedProvider(
            [
                ...Array.from({ length: 9 }, () => ({ events: [runError("rate_limit")] })),
                { events: runText("ok-after-rate-limit") },
            ],
            log,
        );

        const gen = runModelCallWithRecovery({
            // maxRetries=2 would have terminated a general retry loop long
            // before 9 attempts — rate_limit must use its own budget.
            state: mkState(),
            config: { ...baseConfig, recovery: { ...baseConfig.recovery, maxRetries: 2 } },
            initialProvider: provider,
            initialModel: "model-a",
            budget: { maxTokens: 4000, initialMaxTokens: 4000, tokensFreedThisTurn: 0 },
            initialMessages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
            providerOptions: {},
        });

        const { events, out } = (await collect(gen)) as {
            events: Event[];
            out: { result: { text: string; stopReason: string } };
        };

        expect(out.result.text).toBe("ok-after-rate-limit");
        expect(out.result.stopReason).toBe("end_turn");
        expect(log.length).toBe(10);
        const retries = events.filter((e) => e.type === "recovery.retry");
        expect(retries.length).toBe(9);
        expect(
            retries.every(
                (e) =>
                    (e as { kind?: string }).kind === "rate_limit" &&
                    (e as { action?: string }).action === "backoff",
            ),
        ).toBe(true);
    });

    test("rate_limit gives up after exhausting its own budget", async () => {
        const log: ProviderInput[] = [];
        const provider = scriptedProvider(
            Array.from({ length: 12 }, () => ({ events: [runError("rate_limit")] })),
            log,
        );

        const gen = runModelCallWithRecovery({
            state: mkState(),
            config: {
                ...baseConfig,
                recovery: {
                    ...baseConfig.recovery,
                    rateLimitMaxRetries: 3,
                    rateLimitBackoffBaseMs: 1,
                    rateLimitBackoffMaxMs: 1,
                },
            },
            initialProvider: provider,
            initialModel: "model-a",
            budget: { maxTokens: 4000, initialMaxTokens: 4000, tokensFreedThisTurn: 0 },
            initialMessages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
            providerOptions: {},
        });

        const { out } = (await collect(gen)) as {
            events: Event[];
            out: { result: { stopReason: string; error?: ProviderError } };
        };

        expect(out.result.stopReason).toBe("error");
        expect(out.result.error?.kind).toBe("rate_limit");
        // Initial attempt + 3 retries = 4 total calls.
        expect(log.length).toBe(4);
    });

    test("exhausts retry budget and surfaces error", async () => {
        const log: ProviderInput[] = [];
        const provider = scriptedProvider(
            Array.from({ length: 6 }, () => ({ events: [runError("server")] })),
            log,
        );

        const gen = runModelCallWithRecovery({
            state: mkState(),
            config: { ...baseConfig, recovery: { ...baseConfig.recovery, maxRetries: 2 } },
            initialProvider: provider,
            initialModel: "model-a",
            budget: { maxTokens: 4000, initialMaxTokens: 4000, tokensFreedThisTurn: 0 },
            initialMessages: [{ role: "user", content: "hi" }],
            tools: [],
            signal: new AbortController().signal,
            providerOptions: {},
        });

        const { out } = (await collect(gen)) as {
            events: Event[];
            out: { result: { stopReason: string; error?: ProviderError } };
        };

        expect(out.result.stopReason).toBe("error");
        expect(out.result.error?.kind).toBe("server");
        expect(log.length).toBeLessThanOrEqual(3);
    });
});
