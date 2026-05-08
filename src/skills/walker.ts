import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFile } from "./parse.ts";
import type { Skill, SkillSource, SkillTier } from "./types.ts";
import { SkillError } from "./types.ts";

interface WalkResult {
    readonly skills: readonly Skill[];
    readonly errors: readonly SkillError[];
}

export const walkSkillsDir = async (dir: string, tier: SkillTier): Promise<WalkResult> => {
    if (!existsSync(dir)) {
        return { skills: [], errors: [] };
    }

    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return { skills: [], errors: [] };
    }

    const skills: Skill[] = [];
    const errors: SkillError[] = [];

    for (const entry of entries) {
        const dirPath = join(dir, entry);
        let stat;
        try {
            stat = statSync(dirPath);
        } catch {
            continue;
        }
        if (!stat.isDirectory()) continue;

        const skillFile = join(dirPath, "SKILL.md");
        if (!existsSync(skillFile)) continue;

        let text: string;
        try {
            text = await Bun.file(skillFile).text();
        } catch {
            continue;
        }

        const source: SkillSource = { tier, path: skillFile, directory: dirPath };
        const result = parseSkillFile({ text, source, directoryName: entry });
        if (result instanceof SkillError) {
            errors.push(result);
            continue;
        }
        skills.push(result);
    }

    return { skills, errors };
};
