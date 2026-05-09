import { buildVerificationPrompt } from "../systemPrompts.ts";

export const VERIFICATION_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "Bash"];

export const verificationTurnBudget = 12;

export const verificationSystemPrompt = (cwd: string): string =>
    buildVerificationPrompt(cwd, VERIFICATION_TOOLS);
