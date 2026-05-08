import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

export const RewindCommand: SlashCommand = {
    name: "rewind",
    description: "Rewind to before an earlier user message — restores files and truncates history.",
    execute: async (_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        try {
            const applied = await ctx.rewind();
            if (applied) ctx.addSystemMessage("Rewound. Files restored and history trimmed.");
            return { kind: "ok" };
        } catch (e) {
            return { kind: "error", message: e instanceof Error ? e.message : String(e) };
        }
    },
};
