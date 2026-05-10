import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

export const ContextCommand: SlashCommand = {
    name: "context",
    description: "Show context window usage by category.",
    execute: async (_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const ok = await ctx.showContextPanel();
        if (!ok) {
            return { kind: "error", message: "Context panel unavailable — session not ready." };
        }
        return { kind: "ok" };
    },
};
