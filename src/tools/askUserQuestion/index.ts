import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

export interface UserQuestionOption {
    readonly label: string;
    readonly description?: string;
}

export interface UserQuestionItem {
    readonly question: string;
    readonly options: readonly UserQuestionOption[];
    readonly multiSelect: boolean;
}

export interface UserQuestionResult {
    readonly kind: "user_question";
    readonly questions: readonly UserQuestionItem[];
}

// Claude Code's AskUserQuestion takes a `questions` array and Ye's takes one
// question, so a Claude model hands us either shape depending on which schema
// it is reading (through dario it reads Claude Code's). No key rename can
// flatten an array of questions into one, so both shapes are accepted here and
// the pipeline asks them in sequence.
interface AskUserQuestionArgs {
    readonly question?: unknown;
    readonly options?: unknown;
    readonly multiSelect?: unknown;
    readonly questions?: readonly unknown[];
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

const normalizeQuestion = (raw: unknown, prefix: string): UserQuestionItem | string => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return `${prefix}must be an object with 'question' and 'options'`;
    }
    const q = raw as { question?: unknown; options?: unknown; multiSelect?: unknown };
    if (typeof q.question !== "string" || q.question.length === 0) {
        return `${prefix}needs a non-empty 'question' string`;
    }
    if (!Array.isArray(q.options)) {
        return `${prefix}needs an 'options' array`;
    }
    if (q.options.length < 2 || q.options.length > 4) {
        return `${prefix}options must have between 2 and 4 entries`;
    }
    const options: UserQuestionOption[] = [];
    for (let i = 0; i < q.options.length; i += 1) {
        const out = normalizeOption(q.options[i], i);
        if (typeof out === "string") return `${prefix}${out}`;
        options.push(out);
    }
    return { question: q.question, options, multiSelect: q.multiSelect === true };
};

const execute = async (
    rawArgs: unknown,
    _ctx: ToolContext,
): Promise<ToolResult<UserQuestionResult>> => {
    const v = validateArgs<AskUserQuestionArgs>(rawArgs, AskUserQuestionTool.schema);
    if (!v.ok) return v;

    if (v.value.questions === undefined && v.value.question === undefined) {
        return {
            ok: false,
            error:
                "AskUserQuestion needs either {question, options} or " +
                "{questions: [{question, options}]}",
        };
    }

    const raw = v.value.questions ?? [v.value];
    if (raw.length === 0) {
        return { ok: false, error: "questions must have at least one entry" };
    }

    const questions: UserQuestionItem[] = [];
    for (let i = 0; i < raw.length; i += 1) {
        const prefix = raw.length > 1 ? `question ${i + 1}: ` : "";
        const out = normalizeQuestion(raw[i], prefix);
        if (typeof out === "string") return { ok: false, error: out };
        questions.push(out);
    }

    return { ok: true, value: { kind: "user_question", questions } };
};

export const AskUserQuestionTool: Tool = {
    name: "AskUserQuestion",
    description:
        "Ask the user a structured question with 2-4 options. Each option is EITHER a " +
        "plain string (the label shown to the user) OR an object " +
        "{ label: string, description?: string } where description renders dim under the " +
        "label. Set multiSelect:true to let the user pick multiple options. Returns the " +
        "chosen label (or comma-joined labels when multiSelect). Use this for branching " +
        "decisions where prose back-and-forth would be slow. To ask several questions in " +
        "one call, pass `questions`: an array of { question, options, multiSelect? } " +
        "objects, which are put to the user one after another.",
    // Doesn't touch filesystem or run commands — auto-allowed in NORMAL mode.
    // The user already interacts with the picker; a separate y/n gate would be redundant.
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        properties: {
            question: { type: "string" },
            // No `items` schema on either array: an option may be a plain
            // string or a { label, description } object, and normalizeOption
            // is the authority on both — a schema strict enough to catch the
            // object form rejects the string form outright.
            options: { type: "array" },
            multiSelect: { type: "boolean" },
            questions: { type: "array" },
        },
    },
    execute,
};

export const isUserQuestion = (value: unknown): value is UserQuestionResult =>
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "user_question";
