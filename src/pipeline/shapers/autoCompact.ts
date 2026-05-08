import { estimateTokens } from "./tokens.ts";
import { runSummarizeAndReplace } from "./summarize.ts";
import type { Shaper, ShaperContext, ShaperResult } from "./types.ts";

const PRESERVE_RECENT = 4;

// Last-resort shaper. Spends a model call to summarize older history into a
// single message. After Phase 4's cheaper shapers (Snip, Microcompact, Context
// Collapse) run in front of this, autoCompact should rarely fire.
const run = async (ctx: ShaperContext): Promise<ShaperResult> => {
    const { state, messages, config, budget } = ctx;

    if (state.compactedThisTurn || state.shapingFlags.autoCompact) return "skip";

    const threshold = config.compact?.threshold ?? 0.5;
    const tokens = estimateTokens(messages);
    if (tokens / state.contextWindow < threshold) return "skip";

    const { result, freedTokens } = await runSummarizeAndReplace(ctx, {
        preserveRecent: PRESERVE_RECENT,
        promptStyle: "auto-compact",
    });
    if (result === "applied") {
        state.compactedThisTurn = true;
        state.shapingFlags.autoCompact = true;
        budget.tokensFreedThisTurn += freedTokens;
    }
    return result;
};

export const autoCompact: Shaper = {
    name: "autoCompact",
    run,
};
