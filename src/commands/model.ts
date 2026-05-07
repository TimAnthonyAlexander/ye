import { listModels } from "../providers/index.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

export const ModelCommand: SlashCommand = {
    name: "model",
    description: "Show or switch the model for the active provider.",
    usage: "/model [<model-id>]",
    execute: async (args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const arg = args.trim();
        const models = listModels(ctx.providerId);
        if (models.length === 0) {
            return {
                kind: "error",
                message: `No models registered for provider "${ctx.providerId}".`,
            };
        }
        if (arg.length === 0) {
            const lines = models.map(
                (m) => `${m.id === ctx.model ? "*" : " "} ${m.label} — ${m.id}`,
            );
            ctx.addSystemMessage(`Models for ${ctx.providerId}:\n${lines.join("\n")}`);
            return { kind: "ok" };
        }
        const target = models.find((m) => m.id === arg);
        if (!target) {
            return {
                kind: "error",
                message: `Unknown model "${arg}" for ${ctx.providerId}. Run /model to list available models.`,
            };
        }
        if (target.id === ctx.model) {
            ctx.addSystemMessage(`Already using ${target.label}.`);
            return { kind: "ok" };
        }
        try {
            await ctx.setModel(target.id);
            ctx.addSystemMessage(`Model → ${target.label}.`);
            return { kind: "ok" };
        } catch (e) {
            return { kind: "error", message: e instanceof Error ? e.message : String(e) };
        }
    },
};
