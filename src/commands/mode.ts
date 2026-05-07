import type { PermissionMode } from "../config/index.ts";
import { MODE_CYCLE } from "../ui/keybinds.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const isPermissionMode = (value: string): value is PermissionMode =>
    (MODE_CYCLE as readonly string[]).includes(value);

export const ModeCommand: SlashCommand = {
    name: "mode",
    description: "Switch permission mode. Same as Shift+Tab.",
    usage: "/mode <AUTO|NORMAL|PLAN>",
    execute: (args: string, ctx: SlashCommandContext): SlashCommandResult => {
        const arg = args.trim().toUpperCase();
        if (arg.length === 0) {
            ctx.addSystemMessage(`Current mode: ${ctx.mode}. Usage: /mode <AUTO|NORMAL|PLAN>`);
            return { kind: "ok" };
        }
        if (!isPermissionMode(arg)) {
            return {
                kind: "error",
                message: `Unknown mode "${arg}". Valid: ${MODE_CYCLE.join(", ")}.`,
            };
        }
        if (arg === ctx.mode) {
            ctx.addSystemMessage(`Already in ${arg} mode.`);
            return { kind: "ok" };
        }
        ctx.setMode(arg);
        ctx.addSystemMessage(`Mode → ${arg}.`);
        return { kind: "ok" };
    },
};
