import { formatK, formatUsd } from "../components/statusBar.tsx";
import { DARIO_PROVIDER_ID } from "../providers/dario/index.ts";
import {
    billableInputTokens,
    loadSessionUsage,
    loadUsageTotals,
    type CallKindTotals,
} from "../storage/index.ts";
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
    `  ${label.padEnd(12)}↑${formatK(billableInputTokens(t))} ↓${formatK(
        t.outputTokens,
    )} ↻${formatK(t.cacheReadTokens)}  ${formatUsd(t.costUsd)}  (${t.calls} call${
        t.calls === 1 ? "" : "s"
    })`;

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
            `  ${"total".padEnd(12)}↑${formatK(billableInputTokens(lifetime))} ↓${formatK(
                lifetime.outputTokens,
            )} ↻${formatK(lifetime.cacheReadTokens)}  ${formatUsd(lifetime.costUsd)}`,
        );

        // Subscription turns are recorded with no cost at all, so they land as
        // $0.00 here. That is true — the marginal per-token cost is zero — but
        // a screen of zeros reads like broken accounting without saying why.
        if (ctx.providerId === DARIO_PROVIDER_ID) {
            lines.push(
                "",
                "Anthropic (Subscription) turns are not billed per token — they draw on your",
                "Claude plan, so they contribute $0.00 to these totals.",
            );
        }

        ctx.addSystemMessage(lines.join("\n"));
        return { kind: "ok" };
    },
};
