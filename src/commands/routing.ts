import { loadConfig, type RoutingStrategy, saveConfig } from "../config/index.ts";
import type {
    PickerOption,
    SlashCommand,
    SlashCommandContext,
    SlashCommandResult,
} from "./types.ts";

const STRATEGIES: readonly RoutingStrategy[] = ["cheapest", "fastest", "latency", "sticky"];

const STRATEGY_DESCRIPTIONS: Readonly<Record<RoutingStrategy, string>> = {
    cheapest: "Sort OpenRouter sub-providers by price (lowest first). Default.",
    fastest: "Sort by throughput (tokens/sec).",
    latency: "Sort by latency (time-to-first-token).",
    sticky: "Pin to whichever upstream serves the first turn of the session.",
};

const isStrategy = (s: string): s is RoutingStrategy =>
    (STRATEGIES as readonly string[]).includes(s);

const currentRouting = async (): Promise<RoutingStrategy> => {
    const { config } = await loadConfig();
    return config.defaultModel.routing ?? "cheapest";
};

const buildOptions = (): readonly PickerOption[] =>
    STRATEGIES.map((s) => ({
        id: s,
        label: s,
        description: STRATEGY_DESCRIPTIONS[s],
    }));

const applyChoice = async (
    next: RoutingStrategy,
    ctx: SlashCommandContext,
): Promise<SlashCommandResult> => {
    const { config } = await loadConfig();
    if ((config.defaultModel.routing ?? "cheapest") === next) {
        ctx.addSystemMessage(`Routing already set to ${next}.`);
        return { kind: "ok" };
    }
    const nextCfg = {
        ...config,
        defaultModel: {
            ...config.defaultModel,
            routing: next,
        },
    };
    try {
        await saveConfig(nextCfg);
    } catch (e) {
        return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
    ctx.addSystemMessage(`Routing → ${next}. ${STRATEGY_DESCRIPTIONS[next]}`);
    if (ctx.providerId !== "openrouter") {
        ctx.addSystemMessage(
            `Note: routing affects the openrouter provider only. Current provider is ${ctx.providerId}.`,
        );
    }
    return { kind: "ok" };
};

export const RoutingCommand: SlashCommand = {
    name: "routing",
    description:
        "Show or set OpenRouter provider-routing strategy (cheapest, fastest, latency, sticky).",
    usage: "/routing [<cheapest|fastest|latency|sticky>]",
    execute: async (args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const arg = args.trim().toLowerCase();
        if (arg.length === 0) {
            const initial = await currentRouting();
            const choice = await ctx.pick({
                title: `Routing strategy (currently: ${initial})`,
                options: buildOptions(),
                initialId: initial,
            });
            if (!choice) return { kind: "ok" };
            if (!isStrategy(choice)) {
                return { kind: "error", message: `Unknown routing strategy "${choice}".` };
            }
            return applyChoice(choice, ctx);
        }
        if (!isStrategy(arg)) {
            return {
                kind: "error",
                message: `Unknown routing strategy "${arg}". Valid: ${STRATEGIES.join(", ")}.`,
            };
        }
        return applyChoice(arg, ctx);
    },
};
