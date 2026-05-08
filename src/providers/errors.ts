import type { ProviderError, ProviderErrorKind } from "./types.ts";

interface ClassifyHttp {
    readonly status: number;
    readonly body: string;
    readonly fallbackMessage: string;
}

const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
    "rate_limit",
    "overloaded",
    "server",
    "network",
    "stream_error",
    "max_tokens_invalid",
    "prompt_too_long",
]);

const looksLikePromptTooLong = (text: string): boolean => {
    const t = text.toLowerCase();
    return (
        t.includes("prompt is too long") ||
        t.includes("context length") ||
        t.includes("context window") ||
        t.includes("maximum context length") ||
        t.includes("exceeds the maximum") ||
        t.includes("too many tokens") ||
        t.includes("token limit")
    );
};

const looksLikeMaxTokensInvalid = (text: string): boolean => {
    const t = text.toLowerCase();
    return (
        t.includes("max_tokens") &&
        (t.includes("invalid") || t.includes("too large") || t.includes("exceeds"))
    );
};

// Map an HTTP error response to a structured ProviderError. Both providers post
// JSON; we look at the status first, then sniff the body when status alone is
// ambiguous (400 covers prompt-too-long, max_tokens-invalid, and generic-bad).
export const classifyHttpError = ({
    status,
    body,
    fallbackMessage,
}: ClassifyHttp): ProviderError => {
    if (status === 429) {
        return { kind: "rate_limit", message: fallbackMessage, retryable: true, status };
    }
    if (status === 529) {
        return { kind: "overloaded", message: fallbackMessage, retryable: true, status };
    }
    if (status === 401 || status === 403) {
        return { kind: "auth", message: fallbackMessage, retryable: false, status };
    }
    if (status >= 500) {
        return { kind: "server", message: fallbackMessage, retryable: true, status };
    }
    if (status === 400) {
        if (looksLikePromptTooLong(body)) {
            return {
                kind: "prompt_too_long",
                message: fallbackMessage,
                retryable: true,
                status,
            };
        }
        if (looksLikeMaxTokensInvalid(body)) {
            return {
                kind: "max_tokens_invalid",
                message: fallbackMessage,
                retryable: true,
                status,
            };
        }
        return { kind: "bad_request", message: fallbackMessage, retryable: false, status };
    }
    return { kind: "unknown", message: fallbackMessage, retryable: false, status };
};

export const networkError = (message: string): ProviderError => ({
    kind: "network",
    message,
    retryable: true,
});

export const streamError = (message: string): ProviderError => ({
    kind: "stream_error",
    message,
    retryable: true,
});

export const unknownError = (message: string): ProviderError => ({
    kind: "unknown",
    message,
    retryable: false,
});

// Mid-stream provider-error payloads (OpenRouter ships an `error` chunk; Anthropic
// emits an `event: error`). Sniff the message to recover overloaded/rate-limit
// classification when status was 200.
export const classifyMidStreamError = (rawMessage: string): ProviderError => {
    const t = rawMessage.toLowerCase();
    if (t.includes("rate limit") || t.includes("too many requests")) {
        return { kind: "rate_limit", message: rawMessage, retryable: true };
    }
    if (t.includes("overloaded")) {
        return { kind: "overloaded", message: rawMessage, retryable: true };
    }
    if (looksLikePromptTooLong(rawMessage)) {
        return { kind: "prompt_too_long", message: rawMessage, retryable: true };
    }
    return { kind: "stream_error", message: rawMessage, retryable: true };
};

export const isRetryable = (err: ProviderError): boolean =>
    err.retryable && RETRYABLE_KINDS.has(err.kind);
