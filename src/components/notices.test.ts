import { describe, expect, test } from "bun:test";
import type { Config } from "../config/index.ts";
import {
    flushNotices,
    formatRetryNotice,
    formatShaperNotice,
    NO_NOTICES,
    reduceRetryNotice,
    retryLimits,
    type RetryEvent,
    type RetryLimits,
} from "./notices.ts";

const limits: RetryLimits = { maxRetries: 3, rateLimitMaxRetries: 10 };

const retry = (over: Partial<RetryEvent> = {}): RetryEvent => ({
    type: "recovery.retry",
    attempt: 1,
    kind: "overloaded",
    action: "backoff",
    ...over,
});

describe("formatShaperNotice", () => {
    test("names the shaper and rounds the tokens it freed", () => {
        expect(
            formatShaperNotice({
                type: "shaper.applied",
                name: "microcompact",
                tokensFreed: 12_400,
            }),
        ).toBe("✻ microcompact · freed ~12k tokens");
    });

    test("keeps small counts exact", () => {
        expect(formatShaperNotice({ type: "shaper.applied", name: "snip", tokensFreed: 640 })).toBe(
            "✻ snip · freed ~640 tokens",
        );
    });

    test("drops the freed clause when nothing was freed", () => {
        expect(
            formatShaperNotice({ type: "shaper.applied", name: "contextCollapse", tokensFreed: 0 }),
        ).toBe("✻ contextCollapse");
    });
});

describe("formatRetryNotice", () => {
    test("backoff shows a human kind and the attempt out of the budget", () => {
        expect(formatRetryNotice(retry({ attempt: 2 }), limits)).toBe("↻ overloaded · retry 2/3");
    });

    test("a long wait is shown in seconds", () => {
        expect(
            formatRetryNotice(retry({ kind: "rate_limit", attempt: 3, waitMs: 7000 }), limits),
        ).toBe("↻ rate limited · retry 3/10 (7s)");
    });

    test("a sub-second wait is not shown", () => {
        expect(formatRetryNotice(retry({ waitMs: 500 }), limits)).toBe("↻ overloaded · retry 1/3");
    });

    test("the streaming fallback says so instead of counting attempts", () => {
        expect(
            formatRetryNotice(retry({ kind: "stream_error", action: "non_streaming" }), limits),
        ).toBe("↻ stream interrupted · retrying without streaming");
    });

    test("forced shaping and lowered budgets name what changed", () => {
        expect(
            formatRetryNotice(retry({ kind: "prompt_too_long", action: "force_shaper" }), limits),
        ).toBe("↻ prompt too long · compacted history · retry 1/3");
        expect(
            formatRetryNotice(
                retry({ kind: "max_tokens_invalid", action: "lowered_max_tokens" }),
                limits,
            ),
        ).toBe("↻ reply budget rejected · lowered reply budget · retry 1/3");
    });

    test("a model fallback states the model it switched to", () => {
        expect(
            formatRetryNotice(
                retry({ action: "fallback_model", provider: "anthropic", model: "claude-x" }),
                limits,
            ),
        ).toBe("↻ fell back to anthropic/claude-x");
    });

    test("a model fallback without a named model still says a switch happened", () => {
        expect(formatRetryNotice(retry({ action: "fallback_model" }), limits)).toBe(
            "↻ fell back to the backup model",
        );
    });

    test("an unknown kind degrades to its own name", () => {
        expect(formatRetryNotice(retry({ kind: "weird_thing" }), limits)).toBe(
            "↻ weird thing · retry 1/3",
        );
    });
});

describe("coalescing", () => {
    test("the first retry of a kind emits, the rest are silent", () => {
        const first = reduceRetryNotice(NO_NOTICES, retry({ attempt: 1 }), limits);
        expect(first.line).toBe("↻ overloaded · retry 1/3");
        const second = reduceRetryNotice(first.state, retry({ attempt: 2 }), limits);
        expect(second.line).toBeNull();
        const third = reduceRetryNotice(second.state, retry({ attempt: 3 }), limits);
        expect(third.line).toBeNull();
    });

    test("a different kind gets its own first line", () => {
        const first = reduceRetryNotice(NO_NOTICES, retry(), limits);
        const other = reduceRetryNotice(first.state, retry({ kind: "network" }), limits);
        expect(other.line).toBe("↻ network error · retry 1/3");
    });

    test("a model fallback is never folded into a count", () => {
        const first = reduceRetryNotice(NO_NOTICES, retry(), limits);
        const fb = reduceRetryNotice(
            first.state,
            retry({ action: "fallback_model", provider: "openai", model: "gpt-x" }),
            limits,
        );
        expect(fb.line).toBe("↻ fell back to openai/gpt-x");
        expect(fb.state).toBe(first.state);
        expect(flushNotices(fb.state)).toEqual([]);
    });

    test("suppressed retries surface as one summary line", () => {
        let state = NO_NOTICES;
        for (let i = 1; i <= 5; i++) {
            state = reduceRetryNotice(state, retry({ attempt: i }), limits).state;
        }
        expect(flushNotices(state)).toEqual(["↻ overloaded · retried 5 times"]);
    });

    test("a single retry needs no summary", () => {
        const step = reduceRetryNotice(NO_NOTICES, retry(), limits);
        expect(flushNotices(step.state)).toEqual([]);
    });

    test("the state is never mutated in place", () => {
        const step = reduceRetryNotice(NO_NOTICES, retry(), limits);
        expect(NO_NOTICES.retries).toEqual({});
        expect(step.state.retries).toEqual({ overloaded: 1 });
    });
});

describe("retryLimits", () => {
    const base: Config = {
        defaultProvider: "openrouter",
        providers: { openrouter: { baseUrl: "https://x", apiKeyEnv: "K" } },
        defaultModel: { provider: "openrouter", model: "m" },
    };

    test("falls back to the recovery defaults", () => {
        expect(retryLimits(base)).toEqual({ maxRetries: 3, rateLimitMaxRetries: 10 });
    });

    test("configured budgets win", () => {
        expect(
            retryLimits({ ...base, recovery: { maxRetries: 7, rateLimitMaxRetries: 2 } }),
        ).toEqual({ maxRetries: 7, rateLimitMaxRetries: 2 });
    });
});
