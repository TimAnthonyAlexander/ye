import type { Provider } from "../providers/types.ts";
import type { SessionHandle } from "./session.ts";
import { appendUsageRecord } from "./usage.ts";

const TITLE_PROMPT =
    "Generate a concise, sentence-case title (2-5 words) that captures the topic of this coding request. Return ONLY the title text — no JSON, no quotes, no preamble, no trailing punctuation.";

const MAX_TITLE_CHARS = 60;
const MAX_TITLE_TOKENS = 32;
const TITLE_PREFIX = "ye: ";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// OSC injection defense: model output flows into an OSC payload, so any
// residual ESC, BEL, or C0/C1 control character has to go before we hand it
// to the terminal. Tabs/newlines collapse to spaces (preserve word breaks);
// remaining C0/C1 controls + DEL are stripped; surrounding quotes/periods
// trimmed. Hard-cap to MAX_TITLE_CHARS so a runaway model can't blow past
// xterm's realistic title length. Pattern built via RegExp so the source
// stays free of raw control bytes.
const CONTROL_CHARS = new RegExp(
    "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]",
    "g",
);
const WS_CHARS = /[\t\n\r]/g;
const QUOTE_TRIM = /^["'`“”‘’]+|["'`“”‘’.]+$/g;

export const sanitizeTitle = (raw: string): string => {
    const stripped = raw
        .replace(WS_CHARS, " ")
        .replace(CONTROL_CHARS, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(QUOTE_TRIM, "")
        .trim();
    if (stripped.length === 0) return "";
    return stripped.length > MAX_TITLE_CHARS
        ? `${stripped.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
        : stripped;
};

// Map active provider → small, fast model used only for title generation.
// Returns null when the active provider has no registered cheap option, in
// which case the caller skips title generation altogether (still safe; the
// session just falls back to the user-message preview).
export const titleModelFor = (providerId: string): string | null => {
    switch (providerId) {
        case "openrouter":
            return "~google/gemini-flash-latest";
        case "anthropic":
            return "claude-haiku-4-5";
        default:
            return null;
    }
};

export interface GenerateTitleInput {
    readonly provider: Provider;
    readonly model: string;
    readonly userPrompt: string;
    readonly sessionId: string;
    readonly projectId: string;
    readonly signal?: AbortSignal;
}

export const generateSessionTitle = async (input: GenerateTitleInput): Promise<string | null> => {
    let collected = "";
    let errored = false;
    try {
        const stream = input.provider.stream({
            model: input.model,
            messages: [
                { role: "system", content: TITLE_PROMPT },
                { role: "user", content: input.userPrompt },
            ],
            temperature: 0,
            maxTokens: MAX_TITLE_TOKENS,
            signal: input.signal,
            stream: false,
            providerOptions: { reasoning: false },
        });
        for await (const evt of stream) {
            if (evt.type === "text.delta") collected += evt.text;
            else if (evt.type === "usage") {
                try {
                    await appendUsageRecord({
                        sessionId: input.sessionId,
                        projectId: input.projectId,
                        provider: input.provider.id,
                        model: input.model,
                        inputTokens: evt.usage.inputTokens,
                        outputTokens: evt.usage.outputTokens,
                        ...(evt.usage.cacheReadTokens !== undefined
                            ? { cacheReadTokens: evt.usage.cacheReadTokens }
                            : {}),
                        ...(evt.usage.cacheCreationTokens !== undefined
                            ? { cacheCreationTokens: evt.usage.cacheCreationTokens }
                            : {}),
                        ...(evt.usage.costUsd !== undefined ? { costUsd: evt.usage.costUsd } : {}),
                        callKind: "title",
                    });
                } catch {
                    // best-effort
                }
            } else if (evt.type === "stop" && evt.error) errored = true;
        }
    } catch {
        return null;
    }
    if (errored) return null;
    const cleaned = sanitizeTitle(collected);
    return cleaned.length > 0 ? cleaned : null;
};

// process.title writes argv[0] (visible to tmux's automatic-rename via
// /proc/<pid>/comm or sysctl). OSC 0/2 sets the icon+window title for
// emulators that honor it. Doing both maximizes the set of terminals that
// reflect the rename — neither path alone is universal.
export const writeTerminalTitle = (title: string): void => {
    const display = `${TITLE_PREFIX}${title}`;
    try {
        if (typeof process.title === "string") {
            process.title = display;
        }
    } catch {
        // process.title is read-only in some environments — best effort only.
    }
    if (process.stdout.isTTY) {
        process.stdout.write(`${ESC}]0;${display}${BEL}`);
    }
};

export const resetTerminalTitle = (): void => {
    if (process.stdout.isTTY) {
        process.stdout.write(`${ESC}]0;ye${BEL}`);
    }
    try {
        if (typeof process.title === "string") {
            process.title = "ye";
        }
    } catch {
        // see writeTerminalTitle
    }
};

export interface RecordTitleInput {
    readonly session: SessionHandle;
    readonly title: string;
}

export const recordSessionTitle = async (input: RecordTitleInput): Promise<void> => {
    await input.session.appendEvent({ type: "session.title", title: input.title });
};
