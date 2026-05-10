import type { HeuristicReason, ToolCall } from "./types.ts";

export type PromptReason = "tool_use" | "exit_plan_mode" | "enter_plan_mode";

export interface PermissionPromptPayload {
    readonly reason: PromptReason;
    readonly toolCall: ToolCall;
    // For mode-flip prompts: target is the mode being switched into.
    // For exit_plan_mode only: the path to the plan file just written.
    readonly planPath?: string;
    readonly target?: string;
    // Populated when a deterministic safety heuristic elevated this call to a
    // prompt (AUTO mode + risky Bash). The UI surfaces the label so the user
    // understands why an otherwise-allowed call is being asked about.
    readonly promptReason?: HeuristicReason;
}
