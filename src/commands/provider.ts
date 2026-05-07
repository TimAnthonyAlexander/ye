import { PROVIDER_IDS } from "../providers/index.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const formatList = (currentId: string): string => {
    return PROVIDER_IDS.map((id) => `${id === currentId ? "*" : " "} ${id}`).join("\n");
};

export const ProviderCommand: SlashCommand = {
    name: "provider",
    description: "Show or switch the active LLM provider.",
    usage: "/provider [openrouter|anthropic]",
    execute: async (args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const arg = args.trim().toLowerCase();
        if (arg.length === 0) {
            ctx.addSystemMessage(`Providers:\n${formatList(ctx.providerId)}`);
            return { kind: "ok" };
        }
        if (!PROVIDER_IDS.includes(arg)) {
            return {
                kind: "error",
                message: `Unknown provider "${arg}". Valid: ${PROVIDER_IDS.join(", ")}.`,
            };
        }
        if (arg === ctx.providerId) {
            ctx.addSystemMessage(`Already using ${arg}.`);
            return { kind: "ok" };
        }
        try {
            await ctx.setProvider(arg);
            ctx.addSystemMessage(`Provider → ${arg}.`);
            return { kind: "ok" };
        } catch (e) {
            return { kind: "error", message: e instanceof Error ? e.message : String(e) };
        }
    },
};
