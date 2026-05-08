import type { Skill, SkillRegistry } from "./types.ts";

const STATIC_BLURB =
    "Invoke a named user/project skill. Skills are procedural recipes that you can call by name " +
    "to load specialised instructions into your context. Calling Skill itself is read-only — it does " +
    "not require user approval — but the body of a skill may instruct you to run other tools, which " +
    "go through the normal permission flow.\n\n" +
    "Args:\n" +
    "  - command: the skill's name (must be one listed below)\n" +
    "  - args: optional argument string. The skill body may interpolate $0..$N (shell-quoted) and " +
    "$ARGUMENTS (raw).\n\n" +
    "Each entry below is `<name>: <description> [<install-path>]`. The install path is the skill's " +
    "directory on disk — you can Read files inside it (e.g. SKILL.md, references/, scripts/) without " +
    "needing to Glob or guess. Builtins are tagged `<embedded>` and have no on-disk path.\n";

const formatLocation = (skill: Skill): string =>
    skill.source.directory !== null ? skill.source.directory : "<embedded>";

export const buildSkillToolDescription = (registry: SkillRegistry): string => {
    if (registry.modelInvocable.length === 0) {
        return `${STATIC_BLURB}\n<available_skills>\n(no skills installed)\n</available_skills>`;
    }
    const lines = registry.modelInvocable.map(
        (s) => `- ${s.manifest.name}: ${s.manifest.description} [${formatLocation(s)}]`,
    );
    return `${STATIC_BLURB}\n<available_skills>\n${lines.join("\n")}\n</available_skills>`;
};
