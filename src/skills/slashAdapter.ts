import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "../commands/types.ts";
import type { Skill } from "./types.ts";

const buildHiddenPrompt = (skillName: string, rawArgs: string): string =>
    `[Internal slash invocation: the user typed /${skillName}${rawArgs.length > 0 ? ` ${rawArgs}` : ""}. ` +
    `Call the Skill tool with command=${JSON.stringify(skillName)} and args=${JSON.stringify(rawArgs)}, ` +
    `then proceed according to the skill body returned by that tool. Do not ask clarifying questions ` +
    `before invoking the skill — the skill body itself decides whether to ask.]`;

export const skillToSlashCommand = (skill: Skill): SlashCommand => ({
    name: skill.manifest.name,
    description: skill.manifest.description,
    execute: (rawArgs: string, ctx: SlashCommandContext): SlashCommandResult => {
        ctx.sendHiddenPrompt(buildHiddenPrompt(skill.manifest.name, rawArgs));
        return { kind: "ok" };
    },
});
