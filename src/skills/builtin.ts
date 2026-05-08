import frontendDesignSource from "./builtin/frontend-design.SKILL.md" with { type: "text" };
import projectInitSource from "./builtin/project-init.SKILL.md" with { type: "text" };
import { parseSkillFile } from "./parse.ts";
import type { Skill, SkillSource } from "./types.ts";
import { SkillError } from "./types.ts";

const BUILTIN_SOURCES: ReadonlyArray<{ readonly name: string; readonly text: string }> = [
    { name: "frontend-design", text: frontendDesignSource },
    { name: "project-init", text: projectInitSource },
];

export const loadBuiltinSkills = (): readonly Skill[] => {
    const out: Skill[] = [];
    for (const { name, text } of BUILTIN_SOURCES) {
        const source: SkillSource = {
            tier: "builtin",
            path: `<embedded:${name}>`,
            directory: null,
        };
        const result = parseSkillFile({ text, source, directoryName: name });
        if (result instanceof SkillError) continue;
        out.push(result);
    }
    return out;
};
