import type { Shaper, ShaperContext, ShaperResult } from "./types.ts";
import { estimateTokens } from "./tokens.ts";

// Small buffer between the prompt+reply estimate and the hard context window,
// to absorb tokenizer-estimate drift. Cheap insurance.
const SAFETY_MARGIN = 256;

const DEFAULT_MIN_REPLY_TOKENS = 1024;

export type ClampOutcome = "raised" | "lowered" | "skipped" | "infeasible";

// The clamp body, factored out so the orchestrator can re-run it as a
// finalizer after prompt-shrinking shapers free space. Sets
// budget.maxTokens = min(initialMaxTokens, ceiling - promptTokens), bounded
// below by minReplyTokens. Never raises past the initial budget.
export const clampBudget = (ctx: ShaperContext): ClampOutcome => {
    const { state, messages, config, budget } = ctx;
    const minReplyTokens = config.compact?.minReplyTokens ?? DEFAULT_MIN_REPLY_TOKENS;

    const promptTokens = estimateTokens(messages);
    const ceiling = state.contextWindow - SAFETY_MARGIN;
    const available = ceiling - promptTokens;

    if (available < minReplyTokens) return "infeasible";

    const target = Math.min(budget.initialMaxTokens, available);
    if (target === budget.maxTokens) return "skipped";
    const wasRaise = target > budget.maxTokens;
    budget.maxTokens = target;
    return wasRaise ? "raised" : "lowered";
};

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
    const outcome = clampBudget(ctx);
    if (outcome === "lowered") return "done";
    return "skip";
};

export const budgetReduction: Shaper = {
    name: "budgetReduction",
    run,
};
