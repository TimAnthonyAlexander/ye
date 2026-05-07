import { existsSync } from "node:fs";
import { join } from "node:path";

export type NotesFormat = "claude" | "ye";

export interface ProjectNotesFile {
    readonly path: string;
    readonly existed: boolean;
    readonly format: NotesFormat;
}

const CLAUDE_NAME = "CLAUDE.md";
const YE_NAME = "YE.md";

// THE centralizer. The single source of truth for choosing between
// CLAUDE.md and YE.md as the project notes file. No other module
// in Ye should make this decision.
export const getProjectNotesFile = (projectRoot: string): ProjectNotesFile => {
    const claudePath = join(projectRoot, CLAUDE_NAME);
    if (existsSync(claudePath)) {
        return { path: claudePath, existed: true, format: "claude" };
    }
    const yePath = join(projectRoot, YE_NAME);
    if (existsSync(yePath)) {
        return { path: yePath, existed: true, format: "ye" };
    }
    // Neither exists. If we ever need to write project notes, we create YE.md.
    return { path: yePath, existed: false, format: "ye" };
};

export const LOCAL_NOTES_NAME = "YE.local.md";
