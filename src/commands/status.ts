import { effectiveSettings } from "../config/detect.ts";
import { estimateTokens } from "../pipeline/shapers/tokens.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const row = (label: string, value: string): string => `  ${label.padEnd(17)}${value}`;

export const StatusCommand: SlashCommand = {
    name: "status",
    description: "Show provider, model, mode, session, and context usage.",
    execute: (_args: string, ctx: SlashCommandContext): SlashCommandResult => {
        const used = estimateTokens(ctx.getHistory());
        const pct = ctx.contextWindow > 0 ? Math.round((used / ctx.contextWindow) * 100) : 0;
        const bg = ctx.getBackgroundTaskCount();
        ctx.addSystemMessage(
            [
                "Status",
                row("provider", ctx.providerId),
                row("model", ctx.model),
                row("mode", ctx.mode),
                row("session", ctx.sessionId),
                row("cwd", ctx.cwd),
                row("context", `${used} / ${ctx.contextWindow} tokens (${pct}%)`),
                row("background", bg === 0 ? "none" : `${bg} running`),
                ...effectiveSettings(ctx.config, ctx.projectRoot).map((entry) =>
                    row(entry.key, entry.origin ? `${entry.value} (${entry.origin})` : entry.value),
                ),
            ].join("\n"),
        );
        return { kind: "ok" };
    },
};
