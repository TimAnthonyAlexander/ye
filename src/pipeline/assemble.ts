import { userInfo } from "node:os";
import { readNotesHierarchy } from "../memory/index.ts";
import type { Message } from "../providers/index.ts";
import type { SelectedMemoryEntry, SessionState } from "./state.ts";
import { buildSystemPrompt } from "./systemPrompt.ts";

const safeUsername = (): string | undefined => {
    try {
        const u = userInfo().username;
        return u.length > 0 ? u : undefined;
    } catch {
        return undefined;
    }
};

const buildNotesBlock = async (projectRoot: string): Promise<string | null> => {
    const hierarchy = await readNotesHierarchy(projectRoot);
    if (hierarchy.length === 0) return null;
    return `# Project notes\n\n${hierarchy}`;
};

const buildMemoryBlock = (selected: readonly SelectedMemoryEntry[] | null): string | null => {
    if (!selected || selected.length === 0) return null;
    const sections = selected.map(
        (entry) => `----- ${entry.title} (${entry.path}) -----\n\n${entry.content}`,
    );
    return `# Auto-memory\n\n${sections.join("\n\n")}`;
};

export interface AssembleInput {
    readonly state: SessionState;
    readonly model: string;
}

// Step 3: build the messages array sent to the model.
// Parent: full system prompt + project notes hierarchy + auto-memory selection.
// Subagent: honor `systemPromptOverride` exactly (no notes, no memory) so the
// subagent gets exactly the role/tool framing its kind specifies.
export const assemble = async ({ state, model }: AssembleInput): Promise<Message[]> => {
    if (state.systemPromptOverride) {
        return [{ role: "system", content: state.systemPromptOverride }, ...state.history];
    }

    const username = safeUsername();
    const systemBody = buildSystemPrompt({
        cwd: state.projectRoot,
        mode: state.mode,
        model,
        platform: process.platform,
        date: new Date().toISOString().slice(0, 10),
        ...(username ? { username } : {}),
    });
    const notes = await buildNotesBlock(state.projectRoot);
    const memory = buildMemoryBlock(state.selectedMemory);

    const parts = [systemBody];
    if (notes) parts.push(notes);
    if (memory) parts.push(memory);

    const systemMessage: Message = {
        role: "system",
        content: parts.join("\n\n"),
    };

    return [systemMessage, ...state.history];
};
