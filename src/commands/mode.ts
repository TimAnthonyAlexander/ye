import type { PermissionMode } from "../config/index.ts";
import { MODE_CYCLE } from "../ui/keybinds.ts";
import type {
    PickerOption,
    SlashCommand,
    SlashCommandContext,
    SlashCommandResult,
} from "./types.ts";

const isPermissionMode = (value: string): value is PermissionMode =>
    (MODE_CYCLE as readonly string[]).includes(value);

const MODE_DESCRIPTIONS: Readonly<Record<PermissionMode, string>> = {
    NORMAL: "Default. Prompts on state-modifying tools.",
    AUTO: "Auto-allow every tool. Bash has no sandbox in v1.",
    PLAN: "Read-only. Read/Glob/Grep + ExitPlanMode only.",
};

const buildOptions = (): readonly PickerOption[] =>
    MODE_CYCLE.map((m) => ({ id: m, label: m, description: MODE_DESCRIPTIONS[m] }));

const applyChoice = (next: PermissionMode, ctx: SlashCommandContext): SlashCommandResult => {
    if (next === ctx.mode) {
        ctx.addSystemMessage(`Already in ${next} mode.`);
        return { kind: "ok" };
    }
    ctx.setMode(next);
    ctx.addSystemMessage(`Mode → ${next}.`);
    return { kind: "ok" };
};

export const ModeCommand: SlashCommand = {
    name: "mode",
    description: "Switch permission mode. Same as Shift+Tab.",
    usage: "/mode [<AUTO|NORMAL|PLAN>]",
    execute: async (args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const arg = args.trim().toUpperCase();
        if (arg.length === 0) {
            const choice = await ctx.pick({
                title: "Switch permission mode",
                options: buildOptions(),
                initialId: ctx.mode,
            });
            if (!choice) return { kind: "ok" };
            if (!isPermissionMode(choice)) {
                return { kind: "error", message: `Unknown mode "${choice}".` };
            }
            return applyChoice(choice, ctx);
        }
        if (!isPermissionMode(arg)) {
            return {
                kind: "error",
                message: `Unknown mode "${arg}". Valid: ${MODE_CYCLE.join(", ")}.`,
            };
        }
        return applyChoice(arg, ctx);
    },
};
