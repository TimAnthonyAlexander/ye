import { AgentsCommand } from "./agents.ts";
import { BtwCommand } from "./btw.ts";
import { ClearCommand } from "./clear.ts";
import { CompactCommand } from "./compact.ts";
import { ContextCommand } from "./context.ts";
import { CopyCommand } from "./copy.ts";
import { CostCommand } from "./cost.ts";
import { DoctorCommand } from "./doctor.ts";
import { ExitCommand } from "./exit.ts";
import { ExportCommand } from "./export.ts";
import { buildHelpCommand } from "./help.ts";
import { InitCommand } from "./init.ts";
import { LspCommand } from "./lsp.ts";
import { MemoryCommand } from "./memory.ts";
import { ModeCommand } from "./mode.ts";
import { ModelCommand } from "./model.ts";
import { MonitorsCommand } from "./monitors.ts";
import { PermissionsCommand } from "./permissions.ts";
import { ProviderCommand } from "./provider.ts";
import { ResumeCommand } from "./resume.ts";
import { RewindCommand } from "./rewind.ts";
import { RoutingCommand } from "./routing.ts";
import { StatusCommand } from "./status.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

export type {
    OutputSink,
    PickerOption,
    PickerPayload,
    SlashCommand,
    SlashCommandContext,
    SlashCommandResult,
} from "./types.ts";
export { loadMarkdownCommands } from "./markdown.ts";

// Trailing `:` segments carry markdown commands living in subdirectories
// (.ye/commands/git/sync.md → /git:sync). Each segment still has to look like a
// plain command name, so "/usr/bin" and "/foo:" stay non-commands.
const SLASH_PATTERN = /^\/([a-zA-Z][a-zA-Z0-9_-]*(?::[a-zA-Z0-9_-]+)*)(?:\s+([\s\S]*))?$/;

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

let markdownCommands: readonly SlashCommand[] = [];
let skillCommands: readonly SlashCommand[] = [];

// Precedence, highest first: built-in > project markdown > user markdown >
// skill. A dropped name is only dropped from the slash surface — a shadowed
// skill stays model-invocable via the Skill tool.
export const setExtraCommands = (cmds: readonly SlashCommand[]): void => {
    skillCommands = cmds;
};

// Project-over-user is already resolved by the loader, so this list is flat.
export const setMarkdownCommands = (cmds: readonly SlashCommand[]): void => {
    markdownCommands = cmds;
};

const buildBuiltins = (): readonly SlashCommand[] => {
    const helpCommand = buildHelpCommand(() => listCommands());
    return [
        helpCommand,
        ClearCommand,
        ContextCommand,
        CompactCommand,
        CopyCommand,
        CostCommand,
        StatusCommand,
        BtwCommand,
        ExportCommand,
        MemoryCommand,
        PermissionsCommand,
        AgentsCommand,
        MonitorsCommand,
        DoctorCommand,
        LspCommand,
        ModeCommand,
        ProviderCommand,
        ModelCommand,
        RoutingCommand,
        ResumeCommand,
        RewindCommand,
        InitCommand,
        ExitCommand,
    ];
};

const buildRegistry = (): ReadonlyMap<string, SlashCommand> => {
    const builtins = buildBuiltins();
    const reservedNames = new Set<string>();
    for (const cmd of builtins) {
        reservedNames.add(cmd.name.toLowerCase());
        for (const alias of cmd.aliases ?? []) reservedNames.add(alias.toLowerCase());
    }

    const map = new Map<string, SlashCommand>();
    for (const cmd of builtins) {
        map.set(cmd.name.toLowerCase(), cmd);
        for (const alias of cmd.aliases ?? []) map.set(alias.toLowerCase(), cmd);
    }
    const claimed = new Set(reservedNames);
    for (const cmd of [...markdownCommands, ...skillCommands]) {
        const key = cmd.name.toLowerCase();
        if (claimed.has(key)) continue;
        claimed.add(key);
        map.set(key, cmd);
    }
    return map;
};

export const getCommand = (name: string): SlashCommand | undefined =>
    buildRegistry().get(name.toLowerCase());

export const listCommands = (): readonly SlashCommand[] => {
    const registry = buildRegistry();
    const seen = new Set<string>();
    const out: SlashCommand[] = [];
    for (const cmd of registry.values()) {
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
