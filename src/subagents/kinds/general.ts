import { buildGeneralPrompt } from "../systemPrompts.ts";

export const GENERAL_TOOLS: readonly string[] = [
    "Read",
    "Edit",
    "Write",
    "Bash",
    "Grep",
    "Glob",
    "TodoWrite",
];

export const generalTurnBudget = 25;

export const generalSystemPrompt = (cwd: string): string => buildGeneralPrompt(cwd, GENERAL_TOOLS);
