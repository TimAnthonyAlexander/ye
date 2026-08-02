import { existsSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_NOTES_NAME, getProjectNotesFile } from "../memory/index.ts";
import { MANAGED_NOTES_FILE, USER_NOTES_FILE } from "../storage/index.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

interface Level {
    readonly label: string;
    readonly path: string;
    readonly found: boolean;
    readonly note?: string;
}

const buildLevels = (projectRoot: string): readonly Level[] => {
    const project = getProjectNotesFile(projectRoot);
    const local = join(projectRoot, LOCAL_NOTES_NAME);
    return [
        {
            label: "managed",
            path: MANAGED_NOTES_FILE,
            found: existsSync(MANAGED_NOTES_FILE),
        },
        { label: "user", path: USER_NOTES_FILE, found: existsSync(USER_NOTES_FILE) },
        {
            label: "project",
            path: project.path,
            found: project.existed,
            note: "first found wins: CLAUDE.md → YE.md → AGENTS.md",
        },
        { label: "local", path: local, found: existsSync(local) },
    ];
};

export const MemoryCommand: SlashCommand = {
    name: "memory",
    description: "Show the resolved project notes hierarchy.",
    execute: (_args: string, ctx: SlashCommandContext): SlashCommandResult => {
        const lines = buildLevels(ctx.projectRoot).map((level) => {
            const state = level.found ? "found" : "not found";
            const note = level.note ? ` — ${level.note}` : "";
            return `  ${level.label.padEnd(9)}${level.path} (${state})${note}`;
        });
        ctx.addSystemMessage(["Notes hierarchy", ...lines].join("\n"));
        return { kind: "ok" };
    },
};
