import { formatK, formatUsd } from "../components/statusBar.tsx";
import { loadSessionUsage, loadUsageTotals, type CallKindTotals } from "../storage/index.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const KIND_ORDER: readonly string[] = [
    "turn",
    "summarize",
    "title",
    "memory",
    "webSearch",
    "webFetch",
];

const orderKinds = (kinds: readonly string[]): readonly string[] => {
    const known = KIND_ORDER.filter((k) => kinds.includes(k));
    const rest = kinds.filter((k) => !KIND_ORDER.includes(k)).sort();
    return [...known, ...rest];
};

const formatLine = (label: string, t: CallKindTotals): string =>
    `  ${label.padEnd(12)}↑${formatK(t.inputTokens)} ↓${formatK(t.outputTokens)} ↻${formatK(
        t.cacheReadTokens,
    )}  ${formatUsd(t.costUsd)}  (${t.calls} call${t.calls === 1 ? "" : "s"})`;

export const CostCommand: SlashCommand = {
    name: "cost",
    description: "Show token and USD usage for this session and all time.",
    execute: async (_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const [session, lifetime] = await Promise.all([
            loadSessionUsage(ctx.sessionId),
            loadUsageTotals(),
        ]);

        const lines: string[] = ["Session"];
        if (session.totals.calls === 0) {
            lines.push("  (no model calls recorded yet)");
        } else {
            for (const kind of orderKinds(Object.keys(session.byCallKind))) {
                const t = session.byCallKind[kind];
                if (t) lines.push(formatLine(kind, t));
            }
            lines.push(formatLine("total", session.totals));
        }

        lines.push("", "All time");
        lines.push(
            `  ${"total".padEnd(12)}↑${formatK(lifetime.inputTokens)} ↓${formatK(
                lifetime.outputTokens,
            )} ↻${formatK(lifetime.cacheReadTokens)}  ${formatUsd(lifetime.costUsd)}`,
        );

        ctx.addSystemMessage(lines.join("\n"));
        return { kind: "ok" };
    },
};
