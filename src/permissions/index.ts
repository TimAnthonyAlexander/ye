import type { PermissionMode, PermissionRule } from "../config/index.ts";
import { USER_DENIED } from "./messages.ts";
import { applyModeDefault } from "./modes.ts";
import { matchFirst } from "./rules.ts";
import type { Decision, ToolCall } from "./types.ts";

export type { PermissionMode, PermissionRule } from "../config/index.ts";
export { USER_DENIED, PLAN_MODE_BLOCKED } from "./messages.ts";
export { PLAN_ALLOWED } from "./modes.ts";
export { isBlanketDeny } from "./rules.ts";
export type { PermissionPromptPayload, PromptReason } from "./prompt.ts";
export type { Decision, PromptResponse, ToolCall } from "./types.ts";

export interface DecideContext {
  readonly toolCall: ToolCall;
  readonly mode: PermissionMode;
  readonly rules: readonly PermissionRule[];
  readonly isReadOnly: boolean;
}

// Evaluation order per PERMISSIONS.md §Evaluation order:
//   1. Mode-based pre-filter (PLAN allowlist)        — handled in tool pool, but
//                                                       guarded here defensively
//   2. Blanket-deny pre-filter                       — handled in tool pool
//   3. Pattern denies (first match wins)
//   4. Pattern allows (first match wins)
//   5. Mode default (NORMAL prompts; AUTO allows; PLAN denies non-allowlist)
export const decide = (ctx: DecideContext): Decision => {
  // Step 3: pattern denies
  const deny = matchFirst(ctx.rules, "deny", ctx.toolCall);
  if (deny) return { kind: "deny", message: USER_DENIED };

  // Step 4: pattern allows
  const allow = matchFirst(ctx.rules, "allow", ctx.toolCall);
  if (allow) return { kind: "allow" };

  // Step 5: mode default
  return applyModeDefault({
    mode: ctx.mode,
    toolCall: ctx.toolCall,
    isReadOnly: ctx.isReadOnly,
  });
};
