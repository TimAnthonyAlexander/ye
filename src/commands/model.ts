import { loadConfig } from "../config/index.ts";
import { findModel, listModels, resolveApiKey } from "../providers/index.ts";
import {
    findFreeModelLabel,
    loadFreeModelsCache,
    refreshFreeModels,
} from "../providers/openrouter/freeModels.ts";
import type {
    PickerOption,
    SlashCommand,
    SlashCommandContext,
    SlashCommandResult,
} from "./types.ts";

const REFRESH_FREE_ID = "__refresh_free__";
const HDR_STATIC_ID = "__hdr_static__";
const HDR_FREE_ID = "__hdr_free__";

const buildStaticOptions = (providerId: string): PickerOption[] =>
    listModels(providerId).map((m) => ({ id: m.id, label: m.label }));

const buildOpenRouterOptions = (
    cached: readonly {
        readonly id: string;
        readonly label: string;
        readonly contextLength: number;
    }[],
): PickerOption[] => {
    const opts: PickerOption[] = [];
    opts.push({ id: HDR_STATIC_ID, kind: "header", label: "models" });
    for (const m of listModels("openrouter")) {
        opts.push({ id: m.id, label: m.label });
    }
    opts.push({ id: HDR_FREE_ID, kind: "header", label: "free (openrouter)" });
    for (const m of cached) {
        const ctxK = Math.round(m.contextLength / 1000);
        opts.push({ id: m.id, label: `${m.label}  (${ctxK}k ctx)` });
    }
    opts.push({
        id: REFRESH_FREE_ID,
        label: "↻ refresh free models",
        description: "scan OpenRouter for tool-capable free models (~30–60s)",
    });
    return opts;
};

const labelFor = (id: string): string => findModel(id)?.label ?? findFreeModelLabel(id) ?? id;

const handleRefresh = async (ctx: SlashCommandContext): Promise<SlashCommandResult> => {
    ctx.addSystemMessage("Refreshing free models — testing candidates (~30–60s)…");
    const { config } = await loadConfig();
    const provCfg = config.providers["openrouter"];
    if (!provCfg) {
        return { kind: "error", message: "openrouter provider missing from config." };
    }
    const apiKey = resolveApiKey(provCfg);
    if (!apiKey) {
        return {
            kind: "error",
            message: `${provCfg.apiKeyEnv} not set; can't refresh free models.`,
        };
    }
    try {
        const result = await refreshFreeModels(apiKey, (line) => ctx.addSystemMessage(line));
        ctx.addSystemMessage(`Done. ${result.passed}/${result.tested} passed. Run /model to pick.`);
        return { kind: "ok" };
    } catch (e) {
        return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
};

const applyChoice = async (
    nextId: string,
    ctx: SlashCommandContext,
): Promise<SlashCommandResult> => {
    if (nextId === REFRESH_FREE_ID) return handleRefresh(ctx);
    const label = labelFor(nextId);
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
        const isOpenRouter = ctx.providerId === "openrouter";

        let options: PickerOption[];
        let initialId: string | undefined = ctx.model;
        if (isOpenRouter) {
            const cached = (await loadFreeModelsCache()) ?? [];
            options = buildOpenRouterOptions(cached);
            if (cached.length === 0) initialId = REFRESH_FREE_ID;
        } else {
            options = buildStaticOptions(ctx.providerId);
        }

        if (options.filter((o) => o.kind !== "header").length === 0) {
            return {
                kind: "error",
                message: `No models registered for provider "${ctx.providerId}".`,
            };
        }

        if (arg.length === 0) {
            const choice = await ctx.pick({
                title: `Switch model (${ctx.providerId})`,
                options,
                initialId,
            });
            if (!choice) return { kind: "ok" };
            return applyChoice(choice, ctx);
        }
        if (!options.some((o) => o.id === arg && o.kind !== "header")) {
            return {
                kind: "error",
                message: `Unknown model "${arg}" for ${ctx.providerId}. Run /model to pick from the list.`,
            };
        }
        return applyChoice(arg, ctx);
    },
};
