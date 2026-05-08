import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

export interface UserQuestionOption {
    readonly label: string;
    readonly description?: string;
}

export interface UserQuestionResult {
    readonly kind: "user_question";
    readonly question: string;
    readonly options: readonly UserQuestionOption[];
    readonly multiSelect: boolean;
}

interface AskUserQuestionArgs {
    readonly question: string;
    readonly options: readonly unknown[];
    readonly multiSelect?: boolean;
}

const normalizeOption = (raw: unknown, index: number): UserQuestionOption | string => {
    if (typeof raw === "string") {
        if (raw.length === 0) return `option ${index + 1} is an empty string`;
        return { label: raw };
    }
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        const o = raw as { label?: unknown; description?: unknown };
        if (typeof o.label !== "string" || o.label.length === 0) {
            return `option ${index + 1} is an object but missing a non-empty 'label' string`;
        }
        if (o.description !== undefined && typeof o.description !== "string") {
            return `option ${index + 1} 'description' must be a string when present`;
        }
        return o.description !== undefined
            ? { label: o.label, description: o.description }
            : { label: o.label };
    }
    return `option ${index + 1} must be a string or { label, description? } object`;
};

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

    const normalized: UserQuestionOption[] = [];
    for (let i = 0; i < options.length; i += 1) {
        const out = normalizeOption(options[i], i);
        if (typeof out === "string") {
            return { ok: false, error: out };
        }
        normalized.push(out);
    }

    return {
        ok: true,
        value: { kind: "user_question", question, options: normalized, multiSelect },
    };
};

export const AskUserQuestionTool: Tool = {
    name: "AskUserQuestion",
    description:
        "Ask the user a structured question with 2-4 options. Each option is EITHER a " +
        "plain string (the label shown to the user) OR an object " +
        "{ label: string, description?: string } where description renders dim under the " +
        "label. Set multiSelect:true to let the user pick multiple options. Returns the " +
        "chosen label (or comma-joined labels when multiSelect). Use this for branching " +
        "decisions where prose back-and-forth would be slow.",
    // Doesn't touch filesystem or run commands — auto-allowed in NORMAL mode.
    // The user already interacts with the picker; a separate y/n gate would be redundant.
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["question", "options"],
        properties: {
            question: { type: "string" },
            options: {
                type: "array",
                items: {
                    type: "object",
                    required: ["label"],
                    properties: {
                        label: { type: "string" },
                        description: { type: "string" },
                    },
                },
            },
            multiSelect: { type: "boolean" },
        },
    },
    execute,
};

export const isUserQuestion = (value: unknown): value is UserQuestionResult =>
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "user_question";
