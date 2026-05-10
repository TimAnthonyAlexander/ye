import type { PermissionMode, PermissionRule } from "../config/index.ts";
import { classifyBashCommand } from "./heuristics.ts";
import { USER_DENIED } from "./messages.ts";
import { applyModeDefault } from "./modes.ts";
import { matchFirst } from "./rules.ts";
import type { Decision, ToolCall } from "./types.ts";

export type { PermissionMode, PermissionRule } from "../config/index.ts";
export { USER_DENIED, PLAN_MODE_BLOCKED } from "./messages.ts";
export { PLAN_ALLOWED } from "./modes.ts";
export { isBlanketDeny } from "./rules.ts";
export type { PermissionPromptPayload, PromptReason } from "./prompt.ts";
export type { Decision, HeuristicReason, PromptResponse, ToolCall } from "./types.ts";

export interface DecideContext {
    readonly toolCall: ToolCall;
    readonly mode: PermissionMode;
    readonly rules: readonly PermissionRule[];
    readonly isReadOnly: boolean;
    readonly heuristicGating?: boolean;
}

const extractBashCommand = (toolCall: ToolCall): string | null => {
    if (toolCall.name !== "Bash") return null;
    const args = toolCall.args as Record<string, unknown> | null | undefined;
    if (args === null || args === undefined) return null;
    const cmd = args.command;
    return typeof cmd === "string" ? cmd : null;
};

// Evaluation order per PERMISSIONS.md §Evaluation order:
//   1. Mode-based pre-filter (PLAN allowlist)        — handled in tool pool, but
//                                                       guarded here defensively
//   2. Blanket-deny pre-filter                       — handled in tool pool
//   3. Pattern denies (first match wins)
//   4. Pattern allows (first match wins)
//   5. Mode default (NORMAL prompts; AUTO allows; PLAN denies non-allowlist)
//   6. Heuristic gate (safety floor — runs after rules so explicit user
//      allow rules take precedence over heuristics)
export const decide = (ctx: DecideContext): Decision => {
    // Step 3: pattern denies
    const deny = matchFirst(ctx.rules, "deny", ctx.toolCall);
    if (deny) return { kind: "deny", message: USER_DENIED };

    // Step 4: pattern allows
    const allow = matchFirst(ctx.rules, "allow", ctx.toolCall);
    if (allow) return { kind: "allow" };

    // Step 5: mode default
    const modeDecision = applyModeDefault({
        mode: ctx.mode,
        toolCall: ctx.toolCall,
        isReadOnly: ctx.isReadOnly,
    });

    // Step 6: heuristic gate runs as a safety *floor* — it can only make the
    // decision stricter, never looser. If the mode default already denied or
    // prompted, heuristics don't override it downward.
    if (ctx.heuristicGating !== false && modeDecision.kind === "allow") {
        const command = extractBashCommand(ctx.toolCall);
        if (command !== null) {
            const risk = classifyBashCommand(command);
            if (risk.kind === "prompt") {
                return { kind: "prompt", promptReason: risk.reason };
            }
        }
    }

    return modeDecision;
};
