import type { PermissionRule } from "../config/index.ts";
import { matchesPattern, parsePattern } from "./match.ts";
import type { ToolCall } from "./types.ts";

// Rule application. The pattern language itself lives in match.ts (parsed only
// there; extending it elsewhere is a bug).
//
// Returns "deny" / "allow" / null. Caller composes (deny-first applied externally
// by ordering: pre-filter blanket denies, then pattern denies, then pattern allows.)

const ruleMatches = (
    rule: PermissionRule,
    toolCall: ToolCall,
    effect: "allow" | "deny",
): boolean => {
    if (rule.tool !== toolCall.name) return false;
    if (!rule.pattern) return true;
    const parsed = parsePattern(rule.pattern);
    if (parsed.tool !== toolCall.name) return false;
    if (parsed.inner === null) return true;
    return matchesPattern(parsed.inner, toolCall, effect);
};

export interface RuleVerdict {
    readonly effect: "allow" | "deny";
}

// First-match-wins per category. Caller decides ordering (deny-first).
export const matchFirst = (
    rules: readonly PermissionRule[],
    effect: "allow" | "deny",
    toolCall: ToolCall,
): RuleVerdict | null => {
    for (const rule of rules) {
        if (rule.effect !== effect) continue;
        if (ruleMatches(rule, toolCall, effect)) return { effect: rule.effect };
    }
    return null;
};

export const isBlanketDeny = (rule: PermissionRule): boolean =>
    rule.effect === "deny" && (rule.pattern === undefined || rule.pattern === rule.tool);
