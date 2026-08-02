import type { PermissionRule } from "../config/index.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const renderRule = (rule: PermissionRule): string =>
    `    ${rule.effect.padEnd(6)}${rule.pattern ?? rule.tool}`;

const section = (title: string, rules: readonly PermissionRule[]): readonly string[] => {
    if (rules.length === 0) return [`  ${title}: none`];
    return [`  ${title}: ${rules.length}`, ...rules.map(renderRule)];
};

export const PermissionsCommand: SlashCommand = {
    name: "permissions",
    description: "Show the active mode and every permission rule in effect.",
    execute: (_args: string, ctx: SlashCommandContext): SlashCommandResult => {
        const configured = ctx.config.permissions?.rules ?? [];
        const heuristics = ctx.config.permissions?.heuristicGating !== false;
        ctx.addSystemMessage(
            [
                "Permissions",
                `  mode: ${ctx.mode}`,
                `  heuristic gating: ${heuristics ? "on" : "off"}`,
                ...section("config rules", configured),
                ...section("session rules", ctx.getSessionRules()),
            ].join("\n"),
        );
        return { kind: "ok" };
    },
};
