import { buildForkPrompt } from "../systemPrompts.ts";
import { GENERAL_TOOLS, generalTurnBudget } from "./general.ts";

// Same surface as `general` — a fork is a general-purpose agent that happens to
// start with the parent's context. Task stays out of it, so a fork cannot fork.
export const FORK_TOOLS: readonly string[] = GENERAL_TOOLS;

export const forkTurnBudget = generalTurnBudget;

export const forkSystemPrompt = (cwd: string): string => buildForkPrompt(cwd, FORK_TOOLS);

export const forkTaskMessage = (prompt: string): string =>
    [
        "You are a fork of the conversation above. Everything before this message is " +
            "inherited context from the parent agent, not work you did.",
        "",
        "Your task:",
        prompt,
        "",
        "Do only this task, then write one self-contained summary. The parent receives " +
            "that summary and nothing else — it cannot see your tool calls or this " +
            "conversation.",
    ].join("\n");
