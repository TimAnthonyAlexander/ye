import type { ProviderUsage } from "./types.ts";

// USD per 1M tokens. Fields:
//   input            — fresh, uncached input
//   output           — completion / output
//   cacheRead        — cache-hit input (Anthropic cache_read, OpenAI cached_tokens)
//   cacheWrite       — cache-creation input (Anthropic 5min ephemeral default)
// Absent fields = not applicable / not published. Models absent from these
// tables return null cost — totals skip them rather than guess.
//
// Source of truth provided by the user (April–May 2026, official Anthropic /
// OpenAI pricing pages, with explicit overrides for *-pro and *-codex-* SKUs).
// OpenRouter routes get cost directly from `usage.cost` in the API response;
// we never consult these tables for openrouter.
export interface ModelPricing {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
}

const ANTHROPIC_PRICING: Readonly<Record<string, ModelPricing>> = {
    "claude-opus-4-7": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
};

const OPENAI_PRICING: Readonly<Record<string, ModelPricing>> = {
    "gpt-5.5-pro": { input: 30.0, output: 180.0 },
    "gpt-5.5": { input: 5.0, output: 30.0, cacheRead: 0.5 },
    "gpt-5.4": { input: 2.5, output: 15.0, cacheRead: 0.25 },
    "gpt-5.3-codex": { input: 1.75, output: 14.0, cacheRead: 0.175 },
    "gpt-5.2-pro": { input: 21.0, output: 168.0 },
    "gpt-5.2-codex": { input: 1.75, output: 14.0, cacheRead: 0.175 },
    "gpt-5.2": { input: 1.75, output: 14.0, cacheRead: 0.175 },
    "gpt-5.1-codex-max": { input: 1.25, output: 10.0, cacheRead: 0.125 },
    "gpt-5.1-codex-mini": { input: 0.25, output: 2.0, cacheRead: 0.025 },
    "gpt-5.1": { input: 1.25, output: 10.0, cacheRead: 0.125 },
    "gpt-5": { input: 1.25, output: 10.0, cacheRead: 0.125 },
    "gpt-5-mini": { input: 0.25, output: 2.0, cacheRead: 0.025 },
    "codex-mini-latest": { input: 1.5, output: 6.0, cacheRead: 0.375 },
    "gpt-4.1": { input: 2.0, output: 8.0, cacheRead: 0.5 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
};

export const lookupPricing = (providerId: string, model: string): ModelPricing | undefined => {
    if (providerId === "anthropic") return ANTHROPIC_PRICING[model];
    if (providerId === "openai") return OPENAI_PRICING[model];
    // openrouter and any unknown provider: cost comes from API directly
    return undefined;
};

// Compute USD cost from a token breakdown. Returns undefined for models we
// don't have rates for — caller stores that as null/omitted, never zero.
export const computeCostUsd = (
    providerId: string,
    model: string,
    usage: Pick<
        ProviderUsage,
        "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"
    >,
): number | undefined => {
    const p = lookupPricing(providerId, model);
    if (!p) return undefined;
    const inUsd = (usage.inputTokens * p.input) / 1_000_000;
    const outUsd = (usage.outputTokens * p.output) / 1_000_000;
    const cacheReadUsd =
        usage.cacheReadTokens && p.cacheRead !== undefined
            ? (usage.cacheReadTokens * p.cacheRead) / 1_000_000
            : 0;
    const cacheWriteUsd =
        usage.cacheCreationTokens && p.cacheWrite !== undefined
            ? (usage.cacheCreationTokens * p.cacheWrite) / 1_000_000
            : 0;
    return inUsd + outUsd + cacheReadUsd + cacheWriteUsd;
};
