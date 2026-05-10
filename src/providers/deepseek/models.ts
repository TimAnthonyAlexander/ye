// Native DeepSeek context windows. V4 family defaults to 1M (and supports up
// to 1M with `max` effort per their docs recommending ≥384K headroom). Legacy
// aliases `deepseek-chat` / `deepseek-reasoner` route to V4 Flash and are
// scheduled for retirement on 2026-07-24 with no fallback — kept here for the
// transition period.
export const DEEPSEEK_CONTEXT_SIZES: Readonly<Record<string, number>> = {
    "deepseek-v4-pro": 1_000_000,
    "deepseek-v4-flash": 1_000_000,
    "deepseek-chat": 1_000_000,
    "deepseek-reasoner": 1_000_000,
};
