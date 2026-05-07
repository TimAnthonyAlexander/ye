// Hardcoded per-model context-size table. Anthropic does not expose a discovery
// endpoint, so this is the source of truth. Pipeline calls getContextSize(model)
// once per session; if the model is not listed, the provider falls back to
// FALLBACK_CONTEXT_WINDOW.
//
// Opus 4.7, Opus 4.6, and Sonnet 4.6 expose a 1M-token context window on the
// raw Anthropic API. As of 2026-03-13 no beta header is required. Haiku 4.5
// caps at 200K and has no 1M variant.
export const ANTHROPIC_CONTEXT_SIZES: Readonly<Record<string, number>> = {
    "claude-opus-4-7": 1_000_000,
    "claude-opus-4-6": 1_000_000,
    "claude-sonnet-4-6": 1_000_000,
    "claude-haiku-4-5": 200_000,
};

// Opus 4.7 rejects temperature/top_p/top_k. The adapter checks this and skips
// the temperature field on requests.
export const isOpus47 = (model: string): boolean => model.startsWith("claude-opus-4-7");
