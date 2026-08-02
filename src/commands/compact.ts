import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

export const CompactCommand: SlashCommand = {
    name: "compact",
    description: "Summarize older history now, optionally steered by a focus.",
    usage: "/compact [focus text]",
    execute: async (args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const focus = args.trim();
        let result;
        try {
            result = await ctx.compact(focus);
        } catch (e) {
            return {
                kind: "error",
                message: `Compaction failed: ${e instanceof Error ? e.message : String(e)}`,
            };
        }

        if (result.status === "blocked") {
            return { kind: "error", message: "Compaction blocked by a PreCompact hook." };
        }
        if (result.status === "skipped") {
            ctx.addSystemMessage("Nothing to compact — not enough older history yet.");
            return { kind: "ok" };
        }

        const freed = result.beforeTokens - result.afterTokens;
        const suffix = focus.length > 0 ? ` Focus: ${focus}` : "";
        ctx.addSystemMessage(
            `Compacted ${result.beforeTokens} → ${result.afterTokens} tokens (freed ${freed}).${suffix}`,
        );
        return { kind: "ok" };
    },
};
