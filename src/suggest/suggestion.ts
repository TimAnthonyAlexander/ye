import type { Message } from "../providers/types.ts";

export const MAX_SUGGESTION_CHARS = 72;
export const MAX_SUGGESTION_TOKENS = 24;

const MAX_USER_CHARS = 800;
const MAX_ASSISTANT_TAIL_CHARS = 1200;

export const SUGGESTION_PROMPT = [
    "You predict the single next message a developer would send to their coding agent.",
    "Output exactly one short imperative line and nothing else.",
    "No preamble, no quotes, no markdown, no bullets, no explanation, no alternatives.",
    "Keep it under 12 words. Output nothing at all when no sensible next step follows.",
].join(" ");

// Model output lands in a terminal, so ESC/BEL/C0/C1 have to go the same way
// sanitizeTitle strips them. Pattern built via RegExp so the source carries no
// raw control bytes.
const CONTROL_CHARS = new RegExp(
    "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]",
    "g",
);
const LIST_MARKER = /^(?:[-*>]|\d+[.)])\s+/;
const QUOTE_TRIM = /^["'`“”‘’]+|["'`“”‘’]+$/g;

// Truncation has no ellipsis: an accepted suggestion becomes editable buffer
// text, and a "…" would be typed into the prompt the user then sends.
const capLength = (s: string): string => {
    if (s.length <= MAX_SUGGESTION_CHARS) return s;
    const cut = s.slice(0, MAX_SUGGESTION_CHARS);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > MAX_SUGGESTION_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
};

export const sanitizeSuggestion = (raw: string): string | null => {
    const firstLine = raw
        .replace(/\r/g, "\n")
        .split("\n")
        .map((line) => line.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim())
        .find((line) => line.length > 0);
    if (firstLine === undefined) return null;
    const cleaned = capLength(
        firstLine.replace(LIST_MARKER, "").replace(QUOTE_TRIM, "").trim(),
    ).trim();
    return cleaned.length > 0 ? cleaned : null;
};

export const lastRoleText = (history: readonly Message[], role: "user" | "assistant"): string => {
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        if (!msg || msg.role !== role || typeof msg.content !== "string") continue;
        const trimmed = msg.content.trim();
        if (trimmed.length > 0) return trimmed;
    }
    return "";
};

const head = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max));
const tail = (s: string, max: number): string => (s.length <= max ? s : s.slice(s.length - max));

export const buildSuggestionMessages = (
    lastUserPrompt: string,
    lastAssistantText: string,
): readonly Message[] => [
    { role: "system", content: SUGGESTION_PROMPT },
    {
        role: "user",
        content: [
            "Previous user message:",
            head(lastUserPrompt, MAX_USER_CHARS),
            "",
            "End of the assistant's reply:",
            tail(lastAssistantText, MAX_ASSISTANT_TAIL_CHARS),
        ].join("\n"),
    },
];

export interface SuggestionGate {
    readonly enabled: boolean;
    readonly chainFailed: boolean;
    readonly streaming: boolean;
    readonly showing: boolean;
    readonly lastUserPrompt: string;
}

export const shouldGenerateSuggestion = (gate: SuggestionGate): boolean =>
    gate.enabled &&
    !gate.chainFailed &&
    !gate.streaming &&
    !gate.showing &&
    gate.lastUserPrompt.length > 0;

export interface SuggestionVisibility {
    readonly suggestion: string | null;
    readonly buffer: string;
    readonly mentionOpen: boolean;
    readonly searching: boolean;
    readonly disabled: boolean;
}

// A suggestion only exists as ghost text in an otherwise idle, empty input.
// A non-empty buffer also covers the slash picker, which never opens without
// a leading "/" in the buffer.
export const visibleSuggestion = (v: SuggestionVisibility): string | null => {
    if (v.suggestion === null || v.suggestion.length === 0) return null;
    if (v.buffer.length > 0 || v.mentionOpen || v.searching || v.disabled) return null;
    return v.suggestion;
};

export interface SuggestionState {
    readonly text: string | null;
}

export type SuggestionEvent =
    | { readonly type: "show"; readonly text: string }
    | { readonly type: "accept" }
    | { readonly type: "dismiss" }
    | { readonly type: "send" };

export const NO_SUGGESTION: SuggestionState = { text: null };

export const reduceSuggestion = (
    state: SuggestionState,
    event: SuggestionEvent,
): SuggestionState => {
    switch (event.type) {
        case "show":
            // A late arrival never replaces what the user is already looking at.
            return state.text === null ? { text: event.text } : state;
        case "accept":
        case "dismiss":
        case "send":
            return state.text === null ? state : NO_SUGGESTION;
    }
};
