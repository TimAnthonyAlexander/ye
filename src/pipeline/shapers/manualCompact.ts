import type { Config } from "../../config/index.ts";
import { runEventHooks } from "../../hooks/index.ts";
import type { Provider } from "../../providers/index.ts";
import type { SessionState } from "../state.ts";
import { runSummarizeAndReplace } from "./summarize.ts";
import { estimateTokens } from "./tokens.ts";
import type { ShaperContext } from "./types.ts";

const PRESERVE_RECENT = 4;

export type ManualCompactStatus = "compacted" | "blocked" | "skipped";

export interface ManualCompactResult {
    readonly status: ManualCompactStatus;
    readonly beforeTokens: number;
    readonly afterTokens: number;
}

export interface ManualCompactInput {
    readonly state: SessionState;
    readonly provider: Provider;
    readonly config: Config;
    readonly model: string;
    readonly focus: string;
    readonly signal?: AbortSignal;
}

// On-demand counterpart to the autoCompact shaper: same summarizer, no
// threshold check. The PreCompact hook still gates it — a hook that blocks
// automatic compaction must block the manual one too.
export const runManualCompact = async (input: ManualCompactInput): Promise<ManualCompactResult> => {
    const { state, provider, config, model, focus } = input;
    const beforeTokens = estimateTokens(state.history);

    const hook = await runEventHooks(
        config.hooks,
        "PreCompact",
        { project_dir: state.projectRoot },
        input.signal ?? new AbortController().signal,
    );
    if (hook.blocked) {
        return { status: "blocked", beforeTokens, afterTokens: beforeTokens };
    }

    const ctx: ShaperContext = {
        state,
        messages: [...state.history],
        provider,
        config,
        model,
        budget: { maxTokens: 0, initialMaxTokens: 0, tokensFreedThisTurn: 0 },
    };
    const { result } = await runSummarizeAndReplace(ctx, {
        preserveRecent: PRESERVE_RECENT,
        promptStyle: "auto-compact",
        ...(focus.trim().length > 0 ? { focus: focus.trim() } : {}),
    });

    return {
        status: result === "applied" ? "compacted" : "skipped",
        beforeTokens,
        afterTokens: estimateTokens(state.history),
    };
};
