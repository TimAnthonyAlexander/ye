import type { Config, PermissionRule } from "../config/index.ts";

// Session-rule persistence: "allow for the rest of this session" is recorded in
// the session JSONL so resuming the same session keeps the approvals it granted.
// Absent config key means on — a resume that re-prompts for everything the user
// already approved is the behaviour the key exists to turn back on.

export const SESSION_RULE_EVENT = "permission.sessionRule";

export const sessionRulesPersisted = (config: Config): boolean =>
    config.permissions?.persistSessionRules !== false;

export const restoredSessionRules = (
    config: Config,
    replayed: readonly PermissionRule[],
): PermissionRule[] => (sessionRulesPersisted(config) ? [...replayed] : []);

export const parseSessionRuleEvent = (event: Record<string, unknown>): PermissionRule | null => {
    const tool = event["tool"];
    if (typeof tool !== "string" || tool.length === 0) return null;
    const pattern = event["pattern"];
    // Only allows are ever recorded this way; a persisted deny would have to
    // come from config, where the user can see and remove it.
    return {
        effect: "allow",
        tool,
        ...(typeof pattern === "string" && pattern.length > 0 ? { pattern } : {}),
    };
};
