import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

export const buildHelpCommand = (allCommands: () => readonly SlashCommand[]): SlashCommand => ({
    name: "help",
    description: "List available slash commands.",
    execute: (_args: string, ctx: SlashCommandContext): SlashCommandResult => {
        const commands = allCommands();
        const lines = commands.map((c) => {
            const aliases =
                c.aliases && c.aliases.length > 0
                    ? ` (aliases: ${c.aliases.map((a) => `/${a}`).join(", ")})`
                    : "";
            const usage = c.usage ? ` — ${c.usage}` : "";
            return `/${c.name}${usage}${aliases}: ${c.description}`;
        });
        ctx.addSystemMessage(`Available commands:\n${lines.join("\n")}`);
        return { kind: "ok" };
    },
});
