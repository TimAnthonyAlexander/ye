import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

export const ResumeCommand: SlashCommand = {
    name: "resume",
    description:
        "Resume a previous session for this project. Replays history; permissions re-prompt.",
    execute: async (_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        try {
            const loaded = await ctx.resume();
            if (loaded) ctx.addSystemMessage("Session resumed.");
            return { kind: "ok" };
        } catch (e) {
            return { kind: "error", message: e instanceof Error ? e.message : String(e) };
        }
    },
};
