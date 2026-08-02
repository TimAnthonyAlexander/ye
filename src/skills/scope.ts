import type { Skill } from "./types.ts";

// Tool/model narrowing a skill declares in its frontmatter, in force from the
// moment the Skill tool returns until the turn chain that invoked it ends.
// Keyed by session id (subagents run their own chain under their own id), the
// same shape as the background-task managers.
export interface SkillScope {
    readonly skillName: string;
    readonly allowedTools?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly model?: string;
}

const scopes = new Map<string, SkillScope>();

export const buildSkillScope = (skill: Skill, model: string | null): SkillScope | null => {
    const { name, allowedTools, disallowedTools } = skill.manifest;
    if (allowedTools === undefined && disallowedTools === undefined && model === null) return null;
    return {
        skillName: name,
        ...(allowedTools !== undefined ? { allowedTools } : {}),
        ...(disallowedTools !== undefined ? { disallowedTools } : {}),
        ...(model !== null ? { model } : {}),
    };
};

// Last skill wins: a skill that declares nothing clears whatever the previous
// one narrowed, so the scope always reflects the skill currently driving.
export const setSkillScope = (sessionId: string, scope: SkillScope | null): void => {
    if (scope === null) {
        scopes.delete(sessionId);
        return;
    }
    scopes.set(sessionId, scope);
};

export const getSkillScope = (sessionId: string): SkillScope | undefined => scopes.get(sessionId);

export const clearSkillScope = (sessionId: string): void => {
    scopes.delete(sessionId);
};
