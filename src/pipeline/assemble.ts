import { getProjectNotesFile } from "../memory/index.ts";
import type { Message } from "../providers/index.ts";
import type { SessionState } from "./state.ts";

const buildSystemPrompt = (state: SessionState, model: string): string => {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `You are Ye, a coding assistant in a terminal. Today is ${today}. Working directory: ${state.projectRoot}.`,
    `Permission mode: ${state.mode}. PLAN mode allows only Read, Glob, Grep, and ExitPlanMode — propose a plan via ExitPlanMode if you need to make changes.`,
    `Be terse. Prefer editing existing files over creating new ones. Tool calls run in the user's environment with their permission.`,
    `Model: ${model}.`,
  ].join("\n");
};

const buildNotesBlock = async (projectRoot: string): Promise<string | null> => {
  const notes = getProjectNotesFile(projectRoot);
  if (!notes.existed) return null;
  try {
    const content = await Bun.file(notes.path).text();
    if (content.trim().length === 0) return null;
    return `# Project notes (${notes.format === "claude" ? "CLAUDE.md" : "YE.md"})\n\n${content}`;
  } catch {
    return null;
  }
};

export interface AssembleInput {
  readonly state: SessionState;
  readonly model: string;
}

// Step 3: build the messages array sent to the model.
//   system prompt
//   environment + notes-file content (single combined system message)
//   conversation history
export const assemble = async ({ state, model }: AssembleInput): Promise<Message[]> => {
  const systemBody = buildSystemPrompt(state, model);
  const notes = await buildNotesBlock(state.projectRoot);

  const systemMessage: Message = {
    role: "system",
    content: notes ? `${systemBody}\n\n${notes}` : systemBody,
  };

  return [systemMessage, ...state.history];
};
