import type { PermissionMode } from "../config/index.ts";
import { PLAN_MODE_BLOCKED } from "./messages.ts";
import type { Decision, ToolCall } from "./types.ts";

// Tools allowed in PLAN mode. Data, not code branches.
// Skill is included because invoking it is a read-only metadata load (the body
// markdown is injected into context); any side-effecting tool the skill body
// asks the model to call still goes through this same evaluator and gets
// blocked if it isn't on the list.
export const PLAN_ALLOWED: readonly string[] = [
    "Read",
    "Glob",
    "Grep",
    "AskUserQuestion",
    "WebFetch",
    "WebSearch",
    "ExitPlanMode",
    "Skill",
];

interface ModeContext {
    readonly mode: PermissionMode;
    readonly toolCall: ToolCall;
    readonly isReadOnly: boolean;
}

export const applyModeDefault = (ctx: ModeContext): Decision => {
    switch (ctx.mode) {
        case "AUTO":
            return { kind: "allow" };
        case "NORMAL":
            return ctx.isReadOnly ? { kind: "allow" } : { kind: "prompt" };
        case "PLAN":
            return PLAN_ALLOWED.includes(ctx.toolCall.name)
                ? { kind: "allow" }
                : { kind: "deny", message: PLAN_MODE_BLOCKED };
    }
};
