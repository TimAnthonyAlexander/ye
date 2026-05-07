import type { Config } from "../../config/index.ts";
import type { Message, Provider } from "../../providers/index.ts";
import type { SessionState } from "../state.ts";

// Mutable reply-token budget that shapers can read and lower. Wrapped in an
// object so reductions are visible to the orchestrator and to subsequent
// shapers in the chain.
export interface RequestBudget {
    maxTokens: number;
}

export interface ShaperContext {
    readonly state: SessionState;
    // Current assembled message list. The orchestrator swaps this for a
    // freshly-assembled copy after any shaper that mutates state.history.
    messages: Message[];
    readonly provider: Provider;
    readonly config: Config;
    readonly model: string;
    readonly budget: RequestBudget;
}

// "skip"     — trigger condition not met, or the shaper can't help; try next.
// "applied"  — shaper mutated state.history; orchestrator re-assembles before
//              the next shaper runs. Chain continues.
// "done"     — request now fits; orchestrator stops the chain.
export type ShaperResult = "skip" | "applied" | "done";

export interface Shaper {
    readonly name: string;
    run(ctx: ShaperContext): Promise<ShaperResult>;
}
