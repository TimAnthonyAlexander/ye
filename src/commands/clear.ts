import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

export const ClearCommand: SlashCommand = {
    name: "clear",
    aliases: ["new"],
    description: "Clear the chat and start a fresh session. Old transcript is preserved on disk.",
    execute: async (_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        await ctx.clearChat();
        ctx.addSystemMessage("Chat cleared. New session started.");
        return { kind: "ok" };
    },
};
