import {
    CLAUDE_SKILLS_DIR,
    MANAGED_SKILLS_DIR,
    USER_SKILLS_DIR,
    getProjectSkillsDir,
} from "../storage/skillsPaths.ts";
import { loadBuiltinSkills } from "./builtin.ts";
import type { Skill, SkillRegistry } from "./types.ts";
import { walkSkillsDir } from "./walker.ts";

export interface LoadRegistryInput {
    readonly projectRoot: string;
    // Opt-in: also walk ~/.claude/skills/ so SKILL.md files written for Claude
    // Code drop in unchanged. Default off — explicit opt-in keeps cross-agent
    // bleed out of users who don't want it.
    readonly enableClaudeInterop?: boolean;
}

export const loadSkillRegistry = async (input: LoadRegistryInput): Promise<SkillRegistry> => {
    const tiers: ReadonlyArray<readonly Skill[]> = [
        loadBuiltinSkills(),
        (await walkSkillsDir(MANAGED_SKILLS_DIR, "managed")).skills,
        input.enableClaudeInterop === true
            ? (await walkSkillsDir(CLAUDE_SKILLS_DIR, "claude")).skills
            : [],
        (await walkSkillsDir(USER_SKILLS_DIR, "user")).skills,
        (await walkSkillsDir(getProjectSkillsDir(input.projectRoot), "project")).skills,
    ];

    const merged = new Map<string, Skill>();
    for (const tier of tiers) {
        for (const skill of tier) {
            merged.set(skill.manifest.name, skill);
        }
    }

    const all = merged;
    const sorted: readonly Skill[] = [...merged.values()].sort((a, b) =>
        a.manifest.name.localeCompare(b.manifest.name),
    );
    const modelInvocable = sorted.filter((s) => s.manifest.disableModelInvocation !== true);
    const slashBound = sorted;

    return { all, modelInvocable, slashBound };
};

export const emptyRegistry = (): SkillRegistry => ({
    all: new Map(),
    modelInvocable: [],
    slashBound: [],
});
