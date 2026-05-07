import type { Shaper, ShaperContext, ShaperResult } from "./types.ts";
import { estimateTokens } from "./tokens.ts";

// Small buffer between the prompt+reply estimate and the hard context window,
// to absorb tokenizer-estimate drift. Cheap insurance.
const SAFETY_MARGIN = 256;

const DEFAULT_MIN_REPLY_TOKENS = 1024;

// Cheapest shaper. Runs before any prompt-shrinking shaper. Logic:
//
//   - If `promptTokens + budget.maxTokens` already fits in the window: skip.
//   - If we can clamp `budget.maxTokens` down and still leave at least
//     `minReplyTokens` of headroom: clamp + return "done" (request now fits,
//     no further shaping needed this turn).
//   - If even the floor wouldn't fit: skip (let the next shaper shrink the
//     prompt instead).
//
// No model call. No history mutation. Pure request-side knob.
const run = async (ctx: ShaperContext): Promise<ShaperResult> => {
    const { state, messages, config, budget } = ctx;
    const minReplyTokens = config.compact?.minReplyTokens ?? DEFAULT_MIN_REPLY_TOKENS;

    const promptTokens = estimateTokens(messages);
    const ceiling = state.contextWindow - SAFETY_MARGIN;

    if (promptTokens + budget.maxTokens <= ceiling) {
        return "skip";
    }

    const available = ceiling - promptTokens;
    if (available < minReplyTokens) {
        return "skip";
    }

    budget.maxTokens = available;
    return "done";
};

export const budgetReduction: Shaper = {
    name: "budgetReduction",
    run,
};
