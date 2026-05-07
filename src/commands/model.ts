import { findModel, listModels } from "../providers/index.ts";
import type {
    PickerOption,
    SlashCommand,
    SlashCommandContext,
    SlashCommandResult,
} from "./types.ts";

const buildOptions = (providerId: string): readonly PickerOption[] =>
    listModels(providerId).map((m) => ({ id: m.id, label: m.label }));

const applyChoice = async (
    nextId: string,
    ctx: SlashCommandContext,
): Promise<SlashCommandResult> => {
    const target = findModel(nextId);
    const label = target?.label ?? nextId;
    if (nextId === ctx.model) {
        ctx.addSystemMessage(`Already using ${label}.`);
        return { kind: "ok" };
    }
    try {
        await ctx.setModel(nextId);
        ctx.addSystemMessage(`Model → ${label}.`);
        return { kind: "ok" };
    } catch (e) {
        return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
};

export const ModelCommand: SlashCommand = {
    name: "model",
    description: "Show or switch the model for the active provider.",
    usage: "/model [<model-id>]",
    execute: async (args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const arg = args.trim();
        const options = buildOptions(ctx.providerId);
        if (options.length === 0) {
            return {
                kind: "error",
                message: `No models registered for provider "${ctx.providerId}".`,
            };
        }
        if (arg.length === 0) {
            const choice = await ctx.pick({
                title: `Switch model (${ctx.providerId})`,
                options,
                initialId: ctx.model,
            });
            if (!choice) return { kind: "ok" };
            return applyChoice(choice, ctx);
        }
        if (!options.some((o) => o.id === arg)) {
            return {
                kind: "error",
                message: `Unknown model "${arg}" for ${ctx.providerId}. Run /model to pick from the list.`,
            };
        }
        return applyChoice(arg, ctx);
    },
};
