import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

export const BtwCommand: SlashCommand = {
    name: "btw",
    description: "Ask a side question. Neither it nor the answer enters history.",
    usage: "/btw <question>",
    execute: async (args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const question = args.trim();
        if (question.length === 0) {
            return { kind: "error", message: "Usage: /btw <question>" };
        }
        try {
            await ctx.askAside(question);
        } catch (e) {
            return {
                kind: "error",
                message: `Side question failed: ${e instanceof Error ? e.message : String(e)}`,
            };
        }
        return { kind: "ok" };
    },
};
