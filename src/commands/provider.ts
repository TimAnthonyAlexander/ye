import { PROVIDER_IDS } from "../providers/index.ts";
import type {
    PickerOption,
    SlashCommand,
    SlashCommandContext,
    SlashCommandResult,
} from "./types.ts";

const PROVIDER_LABELS: Readonly<Record<string, { label: string; description?: string }>> = {
    openrouter: {
        label: "OpenRouter",
        description: "Multi-model gateway. Default OPENROUTER_API_KEY.",
    },
    anthropic: {
        label: "Anthropic",
        description: "Claude direct. Default ANTHROPIC_API_KEY. Prompt caching enabled.",
    },
};

const buildOptions = (): readonly PickerOption[] =>
    PROVIDER_IDS.map((id) => {
        const meta = PROVIDER_LABELS[id];
        return meta
            ? {
                  id,
                  label: meta.label,
                  ...(meta.description ? { description: meta.description } : {}),
              }
            : { id, label: id };
    });

const applyChoice = async (next: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
    if (next === ctx.providerId) {
        ctx.addSystemMessage(`Already using ${next}.`);
        return { kind: "ok" };
    }
    try {
        await ctx.setProvider(next);
        ctx.addSystemMessage(`Provider → ${next}.`);
        return { kind: "ok" };
    } catch (e) {
        return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
};

export const ProviderCommand: SlashCommand = {
    name: "provider",
    description: "Show or switch the active LLM provider.",
    usage: "/provider [openrouter|anthropic]",
    execute: async (args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const arg = args.trim().toLowerCase();
        if (arg.length === 0) {
            const choice = await ctx.pick({
                title: "Switch provider",
                options: buildOptions(),
                initialId: ctx.providerId,
            });
            if (!choice) return { kind: "ok" };
            return applyChoice(choice, ctx);
        }
        if (!PROVIDER_IDS.includes(arg)) {
            return {
                kind: "error",
                message: `Unknown provider "${arg}". Valid: ${PROVIDER_IDS.join(", ")}.`,
            };
        }
        return applyChoice(arg, ctx);
    },
};
