import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { substituteArgs } from "../skills/argv.ts";
import { parseFrontmatter } from "../skills/parse.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

export type MarkdownCommandTier = "project" | "user";

export interface MarkdownCommandFile {
    readonly description: string | null;
    readonly argumentHint: string | null;
    readonly body: string;
}

export interface DiscoveredMarkdownCommand {
    readonly name: string;
    readonly path: string;
    readonly tier: MarkdownCommandTier;
}

const DELIMITER = "---";
const SEGMENT_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const MAX_DEPTH = 8;

export const PROJECT_COMMANDS_DIR = join(".ye", "commands");

export const userCommandsDir = (): string => join(homedir(), ".ye", "commands");

export const parseMarkdownCommandFile = (text: string): MarkdownCommandFile => {
    const stripped = text.replace(/^\uFEFF/, "");
    const lines = stripped.split("\n");
    const empty = { description: null, argumentHint: null };
    if (lines[0]?.trim() !== DELIMITER) {
        return { ...empty, body: stripped.trim() };
    }

    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === DELIMITER) {
            end = i;
            break;
        }
    }
    if (end === -1) return { ...empty, body: stripped.trim() };

    const body = lines
        .slice(end + 1)
        .join("\n")
        .replace(/^\n+/, "")
        .replace(/\s+$/, "");
    const parsed = parseFrontmatter(lines.slice(1, end).join("\n"));
    if (parsed.error) return { ...empty, body };

    const description = parsed.fields.get("description");
    const argumentHint = parsed.fields.get("argument-hint");
    return {
        description: description && description.length > 0 ? description : null,
        argumentHint: argumentHint && argumentHint.length > 0 ? argumentHint : null,
        body,
    };
};

const walk = async (
    dir: string,
    prefix: readonly string[],
    tier: MarkdownCommandTier,
    depth: number,
    out: DiscoveredMarkdownCommand[],
): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SEGMENT_PATTERN.test(entry.name)) continue;
            await walk(full, [...prefix, entry.name], tier, depth + 1, out);
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const base = entry.name.slice(0, -3);
        if (!SEGMENT_PATTERN.test(base)) continue;
        out.push({ name: [...prefix, base].join(":"), path: full, tier });
    }
};

export const discoverMarkdownCommands = async (
    dir: string,
    tier: MarkdownCommandTier,
): Promise<readonly DiscoveredMarkdownCommand[]> => {
    const out: DiscoveredMarkdownCommand[] = [];
    await walk(dir, [], tier, 0, out);
    return out;
};

export const buildMarkdownCommand = (
    discovered: DiscoveredMarkdownCommand,
    file: MarkdownCommandFile,
): SlashCommand => ({
    name: discovered.name,
    description: file.description ?? `Custom ${discovered.tier} command (${discovered.path}).`,
    ...(file.argumentHint ? { usage: `/${discovered.name} ${file.argumentHint}` } : {}),
    execute: (args: string, ctx: SlashCommandContext): SlashCommandResult => {
        const prompt = substituteArgs(file.body, args.trim());
        if (prompt.trim().length === 0) {
            return { kind: "error", message: `/${discovered.name} has an empty body.` };
        }
        ctx.sendHiddenPrompt(prompt);
        return { kind: "ok" };
    },
});

const loadTier = async (
    dir: string,
    tier: MarkdownCommandTier,
): Promise<readonly SlashCommand[]> => {
    const discovered = await discoverMarkdownCommands(dir, tier);
    const out: SlashCommand[] = [];
    for (const entry of discovered) {
        let text: string;
        try {
            text = await Bun.file(entry.path).text();
        } catch {
            continue;
        }
        out.push(buildMarkdownCommand(entry, parseMarkdownCommandFile(text)));
    }
    return out;
};

export interface LoadMarkdownCommandsInput {
    readonly projectRoot: string;
    readonly userDir?: string;
}

// Project commands beat user commands on a name clash; both lose to built-ins
// (enforced by the registry in index.ts).
export const loadMarkdownCommands = async (
    input: LoadMarkdownCommandsInput,
): Promise<readonly SlashCommand[]> => {
    const user = await loadTier(input.userDir ?? userCommandsDir(), "user");
    const project = await loadTier(join(input.projectRoot, PROJECT_COMMANDS_DIR), "project");
    const byName = new Map<string, SlashCommand>();
    for (const cmd of [...user, ...project]) byName.set(cmd.name.toLowerCase(), cmd);
    return [...byName.values()];
};
