import type { Config } from "../../config/index.ts";
import type { Message, Provider } from "../../providers/index.ts";
import { assemble } from "../assemble.ts";
import type { SessionState } from "../state.ts";
import { autoCompact } from "./autoCompact.ts";
import { budgetReduction } from "./budgetReduction.ts";
import type { RequestBudget, Shaper, ShaperContext } from "./types.ts";

export type { RequestBudget, Shaper, ShaperContext } from "./types.ts";

const DEFAULT_MAX_TOKENS = 16_384;

// Ordered cheapest → most expensive. Each shaper checks its own trigger and
// returns "skip" if it has nothing to do. Order is the architectural piece —
// adding Snip / Microcompact / Context Collapse later is one entry per file.
const SHAPERS: readonly Shaper[] = [budgetReduction, autoCompact];

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
// view of state.history.
export const runShapers = async (input: RunShapersInput): Promise<RunShapersOutput> => {
    const budget: RequestBudget = {
        maxTokens: input.config.compact?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    };

    const ctx: ShaperContext = {
        state: input.state,
        messages: input.initialMessages,
        provider: input.provider,
        config: input.config,
        model: input.model,
        budget,
    };

    for (const shaper of SHAPERS) {
        const result = await shaper.run(ctx);
        if (result === "done") break;
        if (result === "applied") {
            ctx.messages = await assemble({ state: input.state, model: input.model });
        }
    }

    return { messages: ctx.messages, budget };
};
