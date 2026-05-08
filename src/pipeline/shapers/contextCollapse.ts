import { runSummarizeAndReplace } from "./summarize.ts";
import { estimateTokens } from "./tokens.ts";
import type { Shaper, ShaperContext, ShaperResult } from "./types.ts";

const DEFAULT_THRESHOLD = 0.48;
const DEFAULT_PRESERVE_RECENT = 12;

// Wider preserveRecent window than autoCompact (12 vs. 4) and a lower trigger
// threshold (0.48 vs. 0.5) — fires earlier with less commitment, leaving the
// nuclear-option autoCompact as the true last resort. Mechanically identical
// to autoCompact: one model call to summarize older history, replace with a
// single system message. The shared helper handles the tool-call/tool-result
// boundary-pairing guard.
const run = async (ctx: ShaperContext): Promise<ShaperResult> => {
    const { state, messages, config, budget } = ctx;
    if (state.shapingFlags.contextCollapse) return "skip";

    const threshold = config.compact?.collapseThreshold ?? DEFAULT_THRESHOLD;
    const preserveRecent = config.compact?.collapsePreserveRecent ?? DEFAULT_PRESERVE_RECENT;

    if (estimateTokens(messages) / state.contextWindow < threshold) return "skip";
    if (state.history.length <= preserveRecent) return "skip";

    const { result, freedTokens } = await runSummarizeAndReplace(ctx, {
        preserveRecent,
        promptStyle: "collapse",
    });
    if (result === "applied") {
        state.shapingFlags.contextCollapse = true;
        budget.tokensFreedThisTurn += freedTokens;
    }
    return result;
};

export const contextCollapse: Shaper = {
    name: "contextCollapse",
    run,
};
