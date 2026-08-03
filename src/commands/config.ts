import { resolveFormat, resolveLsp, resolveVerify } from "../config/detect.ts";
import { readRawConfig } from "../config/edit.ts";
import { CONFIG_FILE } from "../config/index.ts";
import { buildRows, type ConfigValue, type InfoRow } from "../config/registry.ts";
import type { Config } from "../config/types.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

// Only paths whose effective value came from src/config/detect.ts. A detected
// value that happens to equal the field default is left alone — the row would
// claim detection for something nothing detected.
export const detectedOverlay = (
    config: Config,
    projectRoot: string,
): Readonly<Record<string, ConfigValue>> => {
    const verify = resolveVerify(config, projectRoot);
    const format = resolveFormat(config, projectRoot);
    const lsp = resolveLsp(config, projectRoot);
    const out: Record<string, ConfigValue> = {};

    for (const step of ["typecheck", "lint"] as const) {
        const command = verify.value[step];
        if (command !== undefined && verify.origins[step] === "detected") {
            out[`verify.${step}`] = command;
        }
    }
    if (config.verify?.enabled === undefined && verify.value.enabled === true) {
        out["verify.enabled"] = true;
    }
    if (config.format?.enabled === undefined && format.value.enabled === true) {
        out["format.enabled"] = true;
    }
    if (config.lsp?.enabled === undefined && lsp.value.enabled === true) {
        out["lsp.enabled"] = true;
    }
    return out;
};

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

const modelPair = (
    pair: { readonly provider: string; readonly model: string } | undefined,
): string => (pair === undefined ? "unset" : `${pair.provider} / ${pair.model}`);

const IN_FILE = "edit in config.json";

export const infoRows = (config: Config): readonly InfoRow[] => [
    {
        kind: "info",
        section: "model",
        label: "defaultModel",
        value: `${config.defaultProvider} / ${config.defaultModel.model}`,
        note: "set with /provider and /model",
    },
    {
        kind: "info",
        section: "model",
        label: "cheapModel",
        value: modelPair(config.cheapModel),
        note: IN_FILE,
    },
    {
        kind: "info",
        section: "model",
        label: "providers",
        value: count(Object.keys(config.providers).length, "provider"),
        note: IN_FILE,
    },
    {
        kind: "info",
        section: "permissions",
        label: "rules",
        value: count(config.permissions?.rules.length ?? 0, "rule"),
        note: IN_FILE,
    },
    {
        kind: "info",
        section: "format",
        label: "formatters",
        value: count(Object.keys(config.format?.formatters ?? {}).length, "formatter"),
        note: IN_FILE,
    },
    {
        kind: "info",
        section: "lsp",
        label: "servers",
        value: count(Object.keys(config.lsp?.servers ?? {}).length, "server"),
        note: IN_FILE,
    },
    {
        kind: "info",
        section: "recovery",
        label: "fallbackModel",
        value: modelPair(config.recovery?.fallbackModel),
        note: IN_FILE,
    },
    {
        kind: "info",
        section: "webTools",
        label: "allowedDomains",
        value: count(config.webTools?.allowedDomains?.length ?? 0, "domain"),
        note: IN_FILE,
    },
    {
        kind: "info",
        section: "webTools",
        label: "blockedDomains",
        value: count(config.webTools?.blockedDomains?.length ?? 0, "domain"),
        note: IN_FILE,
    },
    {
        kind: "info",
        section: "hooks",
        label: "hooks",
        value: count(Object.keys(config.hooks ?? {}).length, "event"),
        note: IN_FILE,
    },
];

export const ConfigCommand: SlashCommand = {
    name: "config",
    description: "Edit settings in place: ↑↓ move, ←→ change, Enter types a value, Esc saves.",
    execute: async (_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const raw = await readRawConfig();
        const rows = buildRows(
            raw,
            detectedOverlay(ctx.config, ctx.projectRoot),
            infoRows(ctx.config),
        );

        const edits = await ctx.editConfig(rows);
        if (edits === null) {
            ctx.addSystemMessage("Settings unchanged.");
            return { kind: "ok" };
        }
        if (edits.length === 0) return { kind: "ok" };

        try {
            await ctx.saveConfigEdits(edits);
        } catch (e) {
            return { kind: "error", message: e instanceof Error ? e.message : String(e) };
        }

        ctx.addSystemMessage(
            [
                `Saved ${count(edits.length, "setting")} to ${CONFIG_FILE}`,
                ...edits.map(
                    (edit) =>
                        `  ${edit.path} → ${edit.value === undefined ? "default" : String(edit.value)}`,
                ),
            ].join("\n"),
        );
        return { kind: "ok" };
    },
};
