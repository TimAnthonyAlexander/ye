import type { PermissionRule } from "../config/index.ts";
import type { ToolCall } from "./types.ts";

// v1 pattern syntax (parsed only here; extended elsewhere is a bug):
//   "Tool"                    -> blanket rule, always matches that tool
//   "Tool(prefix:*)"          -> matches when the first string arg starts with `prefix:`
//
// Returns "deny" / "allow" / null. Caller composes (deny-first applied externally
// by ordering: pre-filter blanket denies, then pattern denies, then pattern allows.)

export interface ParsedPattern {
  readonly tool: string;
  readonly prefix: string | null;
}

export const parsePattern = (raw: string): ParsedPattern => {
  const open = raw.indexOf("(");
  if (open === -1) return { tool: raw, prefix: null };
  const close = raw.lastIndexOf(")");
  if (close === -1 || close < open) return { tool: raw, prefix: null };
  const tool = raw.slice(0, open);
  const inner = raw.slice(open + 1, close);
  const trimmed = inner.endsWith(":*") ? inner.slice(0, -2) : inner;
  return { tool, prefix: trimmed };
};

const firstStringArg = (args: unknown): string | null => {
  if (args === null || args === undefined) return null;
  if (typeof args === "string") return args;
  if (typeof args === "object") {
    for (const value of Object.values(args)) {
      if (typeof value === "string") return value;
    }
  }
  return null;
};

const ruleMatches = (rule: PermissionRule, toolCall: ToolCall): boolean => {
  if (rule.tool !== toolCall.name) return false;
  if (!rule.pattern) return true;
  const parsed = parsePattern(rule.pattern);
  if (parsed.tool !== toolCall.name) return false;
  if (parsed.prefix === null) return true;
  const arg = firstStringArg(toolCall.args);
  if (arg === null) return false;
  return arg.startsWith(parsed.prefix);
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
    if (ruleMatches(rule, toolCall)) return { effect: rule.effect };
  }
  return null;
};

export const isBlanketDeny = (rule: PermissionRule): boolean =>
  rule.effect === "deny" && (rule.pattern === undefined || rule.pattern === rule.tool);
