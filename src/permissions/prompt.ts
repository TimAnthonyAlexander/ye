import type { ToolCall } from "./types.ts";

export type PromptReason = "tool_use" | "exit_plan_mode";

export interface PermissionPromptPayload {
    readonly reason: PromptReason;
    readonly toolCall: ToolCall;
    // For exit_plan_mode prompts only: the path to the plan file just written
    // and the mode the user is being asked to switch to on accept.
    readonly planPath?: string;
    readonly target?: string;
}
