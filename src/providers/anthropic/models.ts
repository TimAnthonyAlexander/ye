// Hardcoded per-model context-size table. Anthropic does not expose a discovery
// endpoint, so this is the source of truth. Pipeline calls getContextSize(model)
// once per session; if the model is not listed, the provider falls back to
// FALLBACK_CONTEXT_WINDOW.
//
// Every current model exposes a 1M-token context window on the raw Anthropic
// API with no beta header. Haiku 4.5 caps at 200K and has no 1M variant.
export const ANTHROPIC_CONTEXT_SIZES: Readonly<Record<string, number>> = {
    "claude-fable-5": 1_000_000,
    "claude-opus-5": 1_000_000,
    "claude-opus-4-8": 1_000_000,
    "claude-opus-4-7": 1_000_000,
    "claude-opus-4-6": 1_000_000,
    "claude-sonnet-5": 1_000_000,
    "claude-sonnet-4-6": 1_000_000,
    "claude-haiku-4-5": 200_000,
};

// Sampling params (temperature/top_p/top_k) were removed from Opus 4.7 onward
// and from the whole 5 family — sending one is a 400, not a silent ignore. The
// 4.6 line still accepts them. The adapter skips temperature when this is true.
export const rejectsSampling = (model: string): boolean =>
    model.startsWith("claude-opus-4-7") ||
    model.startsWith("claude-opus-4-8") ||
    model.startsWith("claude-opus-5") ||
    model.startsWith("claude-sonnet-5") ||
    model.startsWith("claude-fable-5");
