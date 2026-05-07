import { getProjectNotesFile } from "../memory/index.ts";
import type { Message } from "../providers/index.ts";
import type { SessionState } from "./state.ts";
import { buildSystemPrompt } from "./systemPrompt.ts";

const buildNotesBlock = async (projectRoot: string): Promise<string | null> => {
    const notes = getProjectNotesFile(projectRoot);
    if (!notes.existed) return null;
    try {
        const content = await Bun.file(notes.path).text();
        if (content.trim().length === 0) return null;
        const filename = notes.format === "claude" ? "CLAUDE.md" : "YE.md";
        return `# Project notes (${filename})\n\n${content}`;
    } catch {
        return null;
    }
};

export interface AssembleInput {
    readonly state: SessionState;
    readonly model: string;
}

// Step 3: build the messages array sent to the model.
//   system prompt (full) + project notes (if present) → one system message
//   then conversation history
export const assemble = async ({ state, model }: AssembleInput): Promise<Message[]> => {
    const systemBody = buildSystemPrompt({
        cwd: state.projectRoot,
        mode: state.mode,
        model,
        platform: process.platform,
        date: new Date().toISOString().slice(0, 10),
    });
    const notes = await buildNotesBlock(state.projectRoot);

    const systemMessage: Message = {
        role: "system",
        content: notes ? `${systemBody}\n\n${notes}` : systemBody,
    };

    return [systemMessage, ...state.history];
};
