import type { Config } from "../config/index.ts";
import type { Event } from "../pipeline/events.ts";
import { DEFAULT_MAX_RETRIES, DEFAULT_RATE_LIMIT_MAX_RETRIES } from "../pipeline/recovery.ts";

export type ShaperEvent = Extract<Event, { type: "shaper.applied" }>;
export type RetryEvent = Extract<Event, { type: "recovery.retry" }>;

const SHAPER_GLYPH = "✻";
const RETRY_GLYPH = "↻";

export interface RetryLimits {
    readonly maxRetries: number;
    readonly rateLimitMaxRetries: number;
}

export const retryLimits = (config: Config): RetryLimits => ({
    maxRetries: config.recovery?.maxRetries ?? DEFAULT_MAX_RETRIES,
    rateLimitMaxRetries: config.recovery?.rateLimitMaxRetries ?? DEFAULT_RATE_LIMIT_MAX_RETRIES,
});

const formatTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export const formatShaperNotice = (event: ShaperEvent): string =>
    event.tokensFreed > 0
        ? `${SHAPER_GLYPH} ${event.name} · freed ~${formatTokens(event.tokensFreed)} tokens`
        : `${SHAPER_GLYPH} ${event.name}`;

const KIND_LABELS: Readonly<Record<string, string>> = {
    rate_limit: "rate limited",
    overloaded: "overloaded",
    server: "provider error",
    network: "network error",
    stream_error: "stream interrupted",
    max_tokens_invalid: "reply budget rejected",
    prompt_too_long: "prompt too long",
};

const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind.replace(/_/g, " ");

const attemptSuffix = (event: RetryEvent, limits: RetryLimits): string => {
    const of = event.kind === "rate_limit" ? limits.rateLimitMaxRetries : limits.maxRetries;
    return `retry ${event.attempt}/${of}`;
};

export const formatRetryNotice = (event: RetryEvent, limits: RetryLimits): string => {
    if (event.action === "fallback_model") {
        const target =
            event.provider && event.model ? `${event.provider}/${event.model}` : "the backup model";
        return `${RETRY_GLYPH} fell back to ${target}`;
    }
    const label = kindLabel(event.kind);
    if (event.action === "non_streaming") {
        return `${RETRY_GLYPH} ${label} · retrying without streaming`;
    }
    const detail =
        event.action === "lowered_max_tokens"
            ? "lowered reply budget · "
            : event.action === "force_shaper"
              ? "compacted history · "
              : "";
    const wait =
        event.waitMs !== undefined && event.waitMs >= 1000
            ? ` (${Math.round(event.waitMs / 1000)}s)`
            : "";
    return `${RETRY_GLYPH} ${label} · ${detail}${attemptSuffix(event, limits)}${wait}`;
};

// Per-turn coalescing state. A stalled provider can produce ten retries in one
// turn; the first one is worth a line, the rest are worth a count.
export interface NoticeState {
    readonly retries: Readonly<Record<string, number>>;
}

export interface NoticeStep {
    readonly state: NoticeState;
    readonly line: string | null;
}

export const NO_NOTICES: NoticeState = { retries: {} };

export const reduceRetryNotice = (
    state: NoticeState,
    event: RetryEvent,
    limits: RetryLimits,
): NoticeStep => {
    // A model switch is never folded into a count: which model answered is a
    // fact about the reply, not noise about the transport.
    if (event.action === "fallback_model") {
        return { state, line: formatRetryNotice(event, limits) };
    }
    const seen = state.retries[event.kind] ?? 0;
    const retries = { ...state.retries, [event.kind]: seen + 1 };
    return {
        state: { retries },
        line: seen === 0 ? formatRetryNotice(event, limits) : null,
    };
};

export const flushNotices = (state: NoticeState): readonly string[] => {
    const lines: string[] = [];
    for (const [kind, count] of Object.entries(state.retries)) {
        if (count < 2) continue;
        lines.push(`${RETRY_GLYPH} ${kindLabel(kind)} · retried ${count} times`);
    }
    return lines;
};
