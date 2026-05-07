import { ClearCommand } from "./clear.ts";
import { ExitCommand } from "./exit.ts";
import { buildHelpCommand } from "./help.ts";
import { InitCommand } from "./init.ts";
import { ModeCommand } from "./mode.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

export type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const SLASH_PATTERN = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/;

export interface ParsedSlash {
    readonly name: string;
    readonly args: string;
}

export const parseSlash = (input: string): ParsedSlash | null => {
    const trimmed = input.trim();
    const match = SLASH_PATTERN.exec(trimmed);
    if (!match || match[1] === undefined) return null;
    return { name: match[1].toLowerCase(), args: match[2] ?? "" };
};

const buildRegistry = (): ReadonlyMap<string, SlashCommand> => {
    const helpCommand = buildHelpCommand(() => listCommands());
    const commands: readonly SlashCommand[] = [
        helpCommand,
        ClearCommand,
        ModeCommand,
        InitCommand,
        ExitCommand,
    ];
    const map = new Map<string, SlashCommand>();
    for (const cmd of commands) {
        map.set(cmd.name, cmd);
        for (const alias of cmd.aliases ?? []) {
            map.set(alias, cmd);
        }
    }
    return map;
};

const REGISTRY = buildRegistry();

export const getCommand = (name: string): SlashCommand | undefined =>
    REGISTRY.get(name.toLowerCase());

export const listCommands = (): readonly SlashCommand[] => {
    const seen = new Set<string>();
    const out: SlashCommand[] = [];
    for (const cmd of REGISTRY.values()) {
        if (seen.has(cmd.name)) continue;
        seen.add(cmd.name);
        out.push(cmd);
    }
    return out;
};

export const dispatch = async (
    parsed: ParsedSlash,
    ctx: SlashCommandContext,
): Promise<SlashCommandResult> => {
    const cmd = getCommand(parsed.name);
    if (!cmd) {
        return { kind: "error", message: `Unknown command: /${parsed.name}. Try /help.` };
    }
    return await cmd.execute(parsed.args, ctx);
};

// Return commands matching the partial input. Used for the picker + Tab completion.
// Empty list means: no picker. We hide it once the user starts typing args (a space appears).
export const matchCommands = (input: string): readonly SlashCommand[] => {
    const trimmed = input.trimStart();
    if (!trimmed.startsWith("/")) return [];
    const afterSlash = trimmed.slice(1);
    if (afterSlash.includes(" ")) return [];
    if (afterSlash.length === 0) return listCommands();
    const prefix = afterSlash.toLowerCase();
    return listCommands().filter((c) => c.name.toLowerCase().startsWith(prefix));
};

// Tab completion. Returns the new input string when there's exactly one match;
// otherwise null (Tab is a no-op).
export const completeCommand = (input: string): string | null => {
    const matches = matchCommands(input);
    if (matches.length !== 1) return null;
    const cmd = matches[0];
    if (!cmd) return null;
    return `/${cmd.name} `;
};
