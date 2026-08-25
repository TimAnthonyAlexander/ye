import {
    CLAUDE_SKILLS_DIR,
    MANAGED_SKILLS_DIR,
    USER_SKILLS_DIR,
    getClaudeProjectSkillsDir,
    getProjectSkillsDir,
} from "../storage/skillsPaths.ts";
import { loadBuiltinSkills } from "./builtin.ts";
import type { Skill, SkillRegistry } from "./types.ts";
import { walkSkillsDir } from "./walker.ts";

export interface LoadRegistryInput {
    readonly projectRoot: string;
}

export const loadSkillRegistry = async (input: LoadRegistryInput): Promise<SkillRegistry> => {
    // Claude Code's skill directories (~/.claude/skills and <project>/.claude/
    // skills) are read unconditionally — most Ye users came from Claude Code and
    // their skills should just work. Ye's own tiers override on name collision,
    // and project beats user. Claude sources derive identity from the directory
    // name (nameFromDirectory), matching how Claude Code resolves them.
    const tiers: ReadonlyArray<readonly Skill[]> = [
        loadBuiltinSkills(),
        (await walkSkillsDir(MANAGED_SKILLS_DIR, "managed")).skills,
        (await walkSkillsDir(CLAUDE_SKILLS_DIR, "claude", true)).skills,
        (await walkSkillsDir(USER_SKILLS_DIR, "user")).skills,
        (await walkSkillsDir(getClaudeProjectSkillsDir(input.projectRoot), "claude-project", true))
            .skills,
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
    const slashBound = sorted.filter((s) => s.manifest.userInvocable !== false);

    return { all, modelInvocable, slashBound };
};

export const emptyRegistry = (): SkillRegistry => ({
    all: new Map(),
    modelInvocable: [],
    slashBound: [],
});
