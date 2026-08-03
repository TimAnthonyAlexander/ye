import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const KEYS: readonly (readonly [string, string])[] = [
    ["Enter", "send the message"],
    ["Shift+Enter", "insert a newline"],
    ["Tab", "accept a file mention, complete a command, accept a suggestion"],
    ["Esc", "dismiss the mention picker or the suggestion"],
    ["↑ / ↓", "walk prompt history (↓ also opens the background task tabs)"],
    ["Shift+Tab", "cycle permission mode (NORMAL → AUTO → PLAN)"],
    ["Ctrl+C", "cancel search, then clear input, then abort the reply — never exits"],
    ["Ctrl+O", "expand or collapse tool-call groups"],
    ["Ctrl+R", "search prompt history across sessions"],
    ["Ctrl+G", "compose the current buffer in $VISUAL / $EDITOR"],
    ["Ctrl+W", "delete the word before the cursor"],
    ["!cmd", "run one shell command"],
    ["@", "open the file-mention picker"],
    ["/", "open the command picker"],
];

const KEY_WIDTH = Math.max(...KEYS.map(([key]) => key.length));

export const helpLines = (commands: readonly SlashCommand[]): readonly string[] => {
    const commandLines = commands.map((c) => {
        const aliases =
            c.aliases && c.aliases.length > 0
                ? ` (aliases: ${c.aliases.map((a) => `/${a}`).join(", ")})`
                : "";
        const usage = c.usage ? ` — ${c.usage}` : "";
        return `/${c.name}${usage}${aliases}: ${c.description}`;
    });
    return [
        "Available commands:",
        ...commandLines,
        "",
        "Keybindings:",
        ...KEYS.map(([key, what]) => `  ${key.padEnd(KEY_WIDTH)}  ${what}`),
    ];
};

export const buildHelpCommand = (allCommands: () => readonly SlashCommand[]): SlashCommand => ({
    name: "help",
    description: "List available slash commands and keybindings.",
    execute: (_args: string, ctx: SlashCommandContext): SlashCommandResult => {
        ctx.addSystemMessage(helpLines(allCommands()).join("\n"));
        return { kind: "ok" };
    },
});
