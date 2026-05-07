// Hardcoded per-model context-size table. Anthropic does not expose a discovery
// endpoint, so this is the source of truth. Pipeline calls getContextSize(model)
// once per session; if the model is not listed, the provider falls back to
// FALLBACK_CONTEXT_WINDOW.
export const ANTHROPIC_CONTEXT_SIZES: Readonly<Record<string, number>> = {
    "claude-opus-4-7": 200_000,
    "claude-opus-4-6": 200_000,
    "claude-sonnet-4-6": 1_000_000,
    "claude-haiku-4-5": 200_000,
};

// Opus 4.7 rejects temperature/top_p/top_k. The adapter checks this and skips
// the temperature field on requests.
export const isOpus47 = (model: string): boolean => model.startsWith("claude-opus-4-7");
