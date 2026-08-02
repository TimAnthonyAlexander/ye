import { basename, join } from "node:path";
import { MANAGED_NOTES_FILE, USER_NOTES_FILE } from "../storage/paths.ts";
import { LOCAL_NOTES_NAME, getProjectNotesFile, readNotesWithImports } from "./notesFile.ts";

interface Level {
    readonly label: string;
    readonly content: string;
}

// Concatenates the 4 levels of project notes (managed, user, project, local)
// in canonical order. Missing or empty levels are silently skipped.
// Delimiter format is defined here and nowhere else.
export const readNotesHierarchy = async (projectRoot: string): Promise<string> => {
    const levels: Level[] = [];

    const managed = await readNotesWithImports(MANAGED_NOTES_FILE);
    if (managed) levels.push({ label: "managed", content: managed });

    const user = await readNotesWithImports(USER_NOTES_FILE);
    if (user) levels.push({ label: "user", content: user });

    const project = getProjectNotesFile(projectRoot);
    if (project.existed) {
        const projectContent = await readNotesWithImports(project.path);
        if (projectContent) {
            levels.push({
                label: `project (${basename(project.path)})`,
                content: projectContent,
            });
        }
    }

    const local = await readNotesWithImports(join(projectRoot, LOCAL_NOTES_NAME));
    if (local) levels.push({ label: "local", content: local });

    if (levels.length === 0) return "";
    return levels.map((l) => `----- ${l.label} -----\n\n${l.content}`).join("\n\n");
};
