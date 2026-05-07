import { existsSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_NOTES_FILE, USER_NOTES_FILE } from "../storage/paths.ts";
import { LOCAL_NOTES_NAME, getProjectNotesFile } from "./notesFile.ts";

interface Level {
    readonly label: string;
    readonly content: string;
}

const readIfPresent = async (path: string): Promise<string | null> => {
    if (!existsSync(path)) return null;
    try {
        const content = await Bun.file(path).text();
        return content.trim().length > 0 ? content : null;
    } catch {
        return null;
    }
};

// Concatenates the 4 levels of project notes (managed, user, project, local)
// in canonical order. Missing or empty levels are silently skipped.
// Delimiter format is defined here and nowhere else.
export const readNotesHierarchy = async (projectRoot: string): Promise<string> => {
    const levels: Level[] = [];

    const managed = await readIfPresent(MANAGED_NOTES_FILE);
    if (managed) levels.push({ label: "managed", content: managed });

    const user = await readIfPresent(USER_NOTES_FILE);
    if (user) levels.push({ label: "user", content: user });

    const project = getProjectNotesFile(projectRoot);
    if (project.existed) {
        const projectContent = await readIfPresent(project.path);
        if (projectContent) {
            const fileName = project.format === "claude" ? "CLAUDE.md" : "YE.md";
            levels.push({ label: `project (${fileName})`, content: projectContent });
        }
    }

    const local = await readIfPresent(join(projectRoot, LOCAL_NOTES_NAME));
    if (local) levels.push({ label: "local", content: local });

    if (levels.length === 0) return "";
    return levels.map((l) => `----- ${l.label} -----\n\n${l.content}`).join("\n\n");
};
