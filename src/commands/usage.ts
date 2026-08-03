import { formatK, formatUsd } from "../components/statusBar.tsx";
import {
    loadUsageWindows,
    type ProviderModelTotals,
    type UsageTotals,
    type UsageWindows,
} from "../storage/index.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const MAX_ROWS = 8;
const MAX_LABEL = 30;

interface Row {
    readonly label: string;
    readonly totals: ProviderModelTotals;
}

const clipLabel = (label: string): string =>
    label.length <= MAX_LABEL ? label : `…${label.slice(label.length - MAX_LABEL + 1)}`;

const toRows = (map: Readonly<Record<string, ProviderModelTotals>>): readonly Row[] =>
    Object.entries(map)
        .map(([label, totals]) => ({ label: clipLabel(label), totals }))
        .sort((a, b) => b.totals.costUsd - a.totals.costUsd || a.label.localeCompare(b.label));

const asBreakdown = (totals: UsageTotals): ProviderModelTotals => ({
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    costUsd: totals.costUsd,
});

const cell = (n: number): string => formatK(n).padStart(6);

const formatRow = (row: Row, width: number, indent: string): string =>
    `${`${indent}${row.label}`.padEnd(width + 4)}  ↑${cell(row.totals.inputTokens)} ↓${cell(
        row.totals.outputTokens,
    )} ↻${cell(row.totals.cacheReadTokens)}  ${formatUsd(row.totals.costUsd).padStart(9)}`;

const section = (title: string, rows: readonly Row[], width: number): readonly string[] => {
    if (rows.length === 0) return [];
    const shown = rows.slice(0, MAX_ROWS);
    const lines = [`  ${title}`, ...shown.map((row) => formatRow(row, width, "    "))];
    const rest = rows.length - shown.length;
    if (rest > 0) lines.push(`    (+${rest} more)`);
    return lines;
};

const totalLabel = (totals: UsageTotals): string =>
    `total (${totals.calls} call${totals.calls === 1 ? "" : "s"})`;

const windowLines = (title: string, totals: UsageTotals, width: number): readonly string[] => {
    if (totals.calls === 0) return [title, "  nothing recorded"];
    return [
        title,
        ...section("by provider", toRows(totals.byProvider), width),
        ...section("by model", toRows(totals.byModel), width),
        formatRow({ label: totalLabel(totals), totals: asBreakdown(totals) }, width, "  "),
    ];
};

export const usageLines = (windows: UsageWindows): readonly string[] => {
    if (windows.allTime.calls === 0) {
        return ["No usage recorded yet — /usage fills in once a model call is made."];
    }
    const width = Math.max(
        ...[windows.day, windows.week, windows.allTime].flatMap((totals) => [
            ...toRows(totals.byProvider).map((row) => row.label.length),
            ...toRows(totals.byModel).map((row) => row.label.length),
            totalLabel(totals).length - 2,
        ]),
        14,
    );
    return [
        ...windowLines("Usage — last 24h", windows.day, width),
        "",
        ...windowLines("Usage — last 7d", windows.week, width),
        "",
        ...windowLines("Usage — all time", windows.allTime, width),
    ];
};

export const UsageCommand: SlashCommand = {
    name: "usage",
    description: "Break down token and USD usage by provider and model over time.",
    execute: async (_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        ctx.addSystemMessage(usageLines(await loadUsageWindows()).join("\n"));
        return { kind: "ok" };
    },
};
