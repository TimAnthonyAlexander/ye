import type { PermissionMode, PermissionRule } from "../config/index.ts";
import { isBlanketDeny, PLAN_ALLOWED } from "../permissions/index.ts";
import type { ToolDefinition } from "../providers/index.ts";
import { listTools } from "./registry.ts";
import { toToolDefinition, type Tool } from "./types.ts";

export interface PoolContext {
    readonly mode: PermissionMode;
    readonly rules: readonly PermissionRule[];
    // When set, the pool is hard-restricted to this list of tool names.
    // Used by subagents to narrow their tool surface (and as the recursion guard:
    // since Task is never in a subagent's allowedTools, recursion is structural).
    readonly allowedTools?: readonly string[];
    // WebSearch is only useful when the active provider has server-side search
    // OR a fallback (DuckDuckGo) is configured. The pool drops it otherwise so
    // the model never tries to call an unavailable tool.
    readonly webSearchAvailable?: boolean;
}

// Single seam where the tool list shown to the model is assembled.
// Order: base → allowedTools narrowing → mode-filter (PLAN allowlist) →
// blanket-deny pre-filter → dedup.
// MCP integration would slot in between blanket-deny and dedup (Phase 7+).
export const assembleToolPool = (ctx: PoolContext): readonly ToolDefinition[] => {
    const base: readonly Tool[] = listTools();

    const allowed = ctx.allowedTools
        ? base.filter((t) => ctx.allowedTools!.includes(t.name))
        : base;

    // PLAN narrows to the allowlist; NORMAL/AUTO drop ExitPlanMode (it's PLAN-only —
    // calling it from NORMAL/AUTO can't be a no-op because the prompt fires on any
    // mode mismatch with the target). EnterPlanMode stays visible in NORMAL/AUTO so
    // the model can request a switch into PLAN.
    const modeFiltered =
        ctx.mode === "PLAN"
            ? allowed.filter((t) => PLAN_ALLOWED.includes(t.name))
            : allowed.filter((t) => t.name !== "ExitPlanMode");

    const blanketDenied = new Set<string>();
    for (const rule of ctx.rules) {
        if (isBlanketDeny(rule)) blanketDenied.add(rule.tool);
    }
    const ruleFiltered = modeFiltered.filter((t) => !blanketDenied.has(t.name));

    const capabilityFiltered =
        ctx.webSearchAvailable === false
            ? ruleFiltered.filter((t) => t.name !== "WebSearch")
            : ruleFiltered;

    const seen = new Set<string>();
    const deduped: Tool[] = [];
    for (const t of capabilityFiltered) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        deduped.push(t);
    }

    return deduped.map(toToolDefinition);
};
