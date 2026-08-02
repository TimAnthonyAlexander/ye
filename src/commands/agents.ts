import { listAgents } from "../subagents/index.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const SOURCE_LABEL: Readonly<Record<string, string>> = {
    builtin: "built-in",
    project: "project",
    user: "user",
};

export const AgentsCommand: SlashCommand = {
    name: "agents",
    description: "List subagents with their source, tools and turn budgets.",
    execute: (_args: string, ctx: SlashCommandContext): SlashCommandResult => {
        const budget = ctx.config.maxTurns?.subagent ?? 25;
        const lines = listAgents(ctx.projectRoot).flatMap((agent) => {
            const turns =
                agent.source === "builtin" && agent.name === "explore"
                    ? agent.turnsLabel
                    : String(Math.min(agent.maxTurns, budget));
            const tools = agent.tools.length > 0 ? agent.tools.join(", ") : "(none)";
            return [
                `  ${agent.name} [${SOURCE_LABEL[agent.source] ?? agent.source}] — ${agent.description}`,
                `    tools: ${tools}`,
                `    turns: ${turns}`,
                ...(agent.path !== null ? [`    file:  ${agent.path}`] : []),
            ];
        });
        ctx.addSystemMessage(["Subagents", ...lines].join("\n"));
        return { kind: "ok" };
    },
};
