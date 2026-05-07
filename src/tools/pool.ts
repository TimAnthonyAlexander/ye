import type { PermissionMode, PermissionRule } from "../config/index.ts";
import { isBlanketDeny, PLAN_ALLOWED } from "../permissions/index.ts";
import type { ToolDefinition } from "../providers/index.ts";
import { listTools } from "./registry.ts";
import { toToolDefinition, type Tool } from "./types.ts";

export interface PoolContext {
    readonly mode: PermissionMode;
    readonly rules: readonly PermissionRule[];
}

// Single seam where the tool list shown to the model is assembled.
// Order: base → mode-filter (PLAN allowlist) → blanket-deny pre-filter → dedup.
// MCP integration would slot in between blanket-deny and dedup (Phase 7+).
export const assembleToolPool = (ctx: PoolContext): readonly ToolDefinition[] => {
    const base: readonly Tool[] = listTools();

    const modeFiltered =
        ctx.mode === "PLAN" ? base.filter((t) => PLAN_ALLOWED.includes(t.name)) : base;

    const blanketDenied = new Set<string>();
    for (const rule of ctx.rules) {
        if (isBlanketDeny(rule)) blanketDenied.add(rule.tool);
    }
    const ruleFiltered = modeFiltered.filter((t) => !blanketDenied.has(t.name));

    const seen = new Set<string>();
    const deduped: Tool[] = [];
    for (const t of ruleFiltered) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        deduped.push(t);
    }

    return deduped.map(toToolDefinition);
};
