import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

export interface UserQuestionResult {
    readonly kind: "user_question";
    readonly question: string;
    readonly options: readonly string[];
    readonly multiSelect: boolean;
}

interface AskUserQuestionArgs {
    readonly question: string;
    readonly options: readonly string[];
    readonly multiSelect?: boolean;
}

const execute = async (
    rawArgs: unknown,
    _ctx: ToolContext,
): Promise<ToolResult<UserQuestionResult>> => {
    const v = validateArgs<AskUserQuestionArgs>(rawArgs, AskUserQuestionTool.schema);
    if (!v.ok) return v;

    const { question, options, multiSelect = false } = v.value;
    if (options.length < 2 || options.length > 4) {
        return { ok: false, error: "options must have between 2 and 4 entries" };
    }
    if (options.some((o) => typeof o !== "string" || o.length === 0)) {
        return { ok: false, error: "every option must be a non-empty string" };
    }

    return {
        ok: true,
        value: { kind: "user_question", question, options, multiSelect },
    };
};

export const AskUserQuestionTool: Tool = {
    name: "AskUserQuestion",
    description:
        "Ask the user a structured question with 2–4 options. Returns the user's choice " +
        "(or comma-joined choices when multiSelect). Use when you need a clear branch " +
        "decision from the user that plain prose would muddle.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["question", "options"],
        properties: {
            question: { type: "string" },
            options: { type: "array" },
            multiSelect: { type: "boolean" },
        },
    },
    execute,
};

export const isUserQuestion = (value: unknown): value is UserQuestionResult =>
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "user_question";
