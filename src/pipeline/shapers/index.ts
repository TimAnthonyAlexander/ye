import type { Config } from "../../config/index.ts";
import { runEventHooks } from "../../hooks/index.ts";
import type { Message, Provider } from "../../providers/index.ts";
import { assemble } from "../assemble.ts";
import type { Event } from "../events.ts";
import type { SessionState } from "../state.ts";
import { autoCompact } from "./autoCompact.ts";
import { budgetReduction, clampBudget } from "./budgetReduction.ts";
import { contextCollapse } from "./contextCollapse.ts";
import { microcompact } from "./microcompact.ts";
import { snip } from "./snip.ts";
import type { RequestBudget, Shaper, ShaperContext } from "./types.ts";

export type { RequestBudget, Shaper, ShaperContext } from "./types.ts";

const DEFAULT_MAX_TOKENS = 16_384;

// Hard cap on history-mutating shaper applications per turn. Belt-and-
// suspenders against any future bug where one-shot flags fail to stick — direct
// lesson from the leaked Claude Code compaction retry-loop bug: every loop has
// an explicit budget.
const MAX_SHAPER_APPLIED_PER_TURN = 4;

// Ordered cheapest → most expensive. Each shaper checks its own trigger and
// returns "skip" if it has nothing to do. Order is the architectural piece —
// adding Snip / Microcompact / Context Collapse later is one entry per file.
const SHAPERS: readonly Shaper[] = [
    budgetReduction,
    snip,
    microcompact,
    contextCollapse,
    autoCompact,
];

export interface RunShapersInput {
    readonly state: SessionState;
    readonly initialMessages: Message[];
    readonly provider: Provider;
    readonly config: Config;
    readonly model: string;
}

export interface RunShapersOutput {
    readonly messages: Message[];
    readonly budget: RequestBudget;
}

// Runs the shaper chain in declared order. Stops early on "done"; re-assembles
// the message list after any "applied" so the next shaper sees the post-shape
// view of state.history. Yields shaper.applied events for observability and
// runs a final clampBudget pass to take advantage of space freed by prompt-
// shrinking shapers.
export async function* runShapers(input: RunShapersInput): AsyncGenerator<Event, RunShapersOutput> {
    // PreCompact hook: run before any compaction. If blocked, skip all shapers.
    const preCompact = await runEventHooks(
        input.config.hooks,
        "PreCompact",
        { project_dir: input.state.projectRoot },
        new AbortController().signal,
    );
    if (preCompact.blocked) {
        const budget: RequestBudget = {
            maxTokens: input.config.compact?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
            initialMaxTokens: input.config.compact?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
            tokensFreedThisTurn: 0,
        };
        return { messages: input.initialMessages, budget };
    }

    const initialMaxTokens = input.config.compact?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    const budget: RequestBudget = {
        maxTokens: initialMaxTokens,
        initialMaxTokens,
        tokensFreedThisTurn: 0,
    };

    const ctx: ShaperContext = {
        state: input.state,
        messages: input.initialMessages,
        provider: input.provider,
        config: input.config,
        model: input.model,
        budget,
    };

    let appliedCount = 0;
    for (const shaper of SHAPERS) {
        if (appliedCount >= MAX_SHAPER_APPLIED_PER_TURN) break;
        const tokensBefore = budget.tokensFreedThisTurn;
        const result = await shaper.run(ctx);
        if (result === "done") break;
        if (result === "applied") {
            appliedCount += 1;
            const tokensFreed = budget.tokensFreedThisTurn - tokensBefore;
            yield { type: "shaper.applied", name: shaper.name, tokensFreed };
            ctx.messages = await assemble({ state: input.state, model: input.model });
        }
    }

    // Re-clamp at the end: prompt-shrinking shapers may have created room for a
    // larger reply budget than the first budgetReduction pass allowed.
    if (appliedCount > 0) clampBudget(ctx);

    return { messages: ctx.messages, budget };
}
