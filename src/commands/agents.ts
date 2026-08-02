import { EXPLORE_TOOLS, exploreTurnBudget } from "../subagents/kinds/explore.ts";
import { GENERAL_TOOLS, generalTurnBudget } from "../subagents/kinds/general.ts";
import { VERIFICATION_TOOLS, verificationTurnBudget } from "../subagents/kinds/verification.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

interface AgentRow {
    readonly name: string;
    readonly tools: readonly string[];
    readonly turns: string;
    readonly summary: string;
}

const ROWS: readonly AgentRow[] = [
    {
        name: "explore",
        tools: EXPLORE_TOOLS,
        turns: `${exploreTurnBudget("quick")} quick / ${exploreTurnBudget(
            "medium",
        )} medium / ${exploreTurnBudget("very_thorough")} very_thorough`,
        summary: "Read-only codebase search.",
    },
    {
        name: "general",
        tools: GENERAL_TOOLS,
        turns: String(generalTurnBudget),
        summary: "Full toolset, AUTO mode.",
    },
    {
        name: "verification",
        tools: VERIFICATION_TOOLS,
        turns: String(verificationTurnBudget),
        summary: "Post-change verification.",
    },
];

export const AgentsCommand: SlashCommand = {
    name: "agents",
    description: "List subagent kinds with their tools and turn budgets.",
    execute: (_args: string, ctx: SlashCommandContext): SlashCommandResult => {
        const lines = ROWS.flatMap((row) => [
            `  ${row.name} — ${row.summary}`,
            `    tools: ${row.tools.join(", ")}`,
            `    turns: ${row.turns}`,
        ]);
        ctx.addSystemMessage(["Subagents", ...lines].join("\n"));
        return { kind: "ok" };
    },
};
