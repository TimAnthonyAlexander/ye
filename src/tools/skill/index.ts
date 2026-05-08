import { substituteArgs } from "../../skills/argv.ts";
import type { Skill, SkillRegistry } from "../../skills/types.ts";
import type { Tool, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface SkillArgs {
    readonly command: string;
    readonly args?: string;
}

interface SkillResult {
    readonly skillName: string;
    readonly body: string;
}

const FALLBACK_DESCRIPTION =
    "Invoke a named skill. The skill registry has not finished loading yet — try again next turn or proceed without skills.";

let registryRef: SkillRegistry | null = null;
let dynamicDescription: string = FALLBACK_DESCRIPTION;

export const setSkillRegistry = (registry: SkillRegistry, description: string): void => {
    registryRef = registry;
    dynamicDescription = description;
};

const formatBody = (skill: Skill, body: string): string => {
    const sourceLine =
        skill.source.tier === "builtin"
            ? `(skill: ${skill.manifest.name}, builtin)`
            : `(skill: ${skill.manifest.name}, ${skill.source.tier})`;
    return `${sourceLine}\n\n${body}`;
};

const execute = async (rawArgs: unknown): Promise<ToolResult<SkillResult>> => {
    const v = validateArgs<SkillArgs>(rawArgs, SkillTool.schema);
    if (!v.ok) return v;
    const { command, args } = v.value;

    const registry = registryRef;
    if (registry === null) {
        return { ok: false, error: "skill registry not available" };
    }

    const skill = registry.all.get(command);
    if (!skill) {
        const known = [...registry.all.keys()].sort().join(", ");
        return {
            ok: false,
            error: `unknown skill: ${command}. Known: ${known.length > 0 ? known : "(none)"}`,
        };
    }

    const substituted = substituteArgs(skill.body, args ?? "");
    return {
        ok: true,
        value: { skillName: skill.manifest.name, body: formatBody(skill, substituted) },
    };
};

export const SkillTool: Tool<SkillArgs, SkillResult> = {
    name: "Skill",
    get description() {
        return dynamicDescription;
    },
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["command"],
        properties: {
            command: { type: "string" },
            args: { type: "string" },
        },
    },
    execute,
};
