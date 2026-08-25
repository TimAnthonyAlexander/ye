import type { Message, Role } from "../types.ts";

interface CacheControl {
    readonly type: "ephemeral";
}

export interface TextPart {
    readonly type: "text";
    readonly text: string;
    readonly cache_control?: CacheControl;
}

// A message on the wire, where content may be widened from a plain string to an
// array of parts so a `cache_control` marker has a concrete object to sit on.
export type WireMessage = Omit<Message, "content"> & {
    readonly content: string | null | readonly TextPart[];
};

// Anthropic bills the full prompt on every request unless the caller marks
// cache breakpoints itself — there is no implicit caching. DeepSeek, OpenAI,
// Gemini and Grok cache automatically, which is why only this family needs
// (and only this family tolerates) the marker.
export const needsExplicitCacheBreakpoints = (model: string): boolean =>
    model.startsWith("anthropic/");

// `assistant` is excluded: its content is null whenever it carries tool_calls,
// and an assistant message is never the tail of a request Ye sends.
const MARKABLE: ReadonlySet<Role> = new Set<Role>(["system", "user", "tool"]);

// Whitespace-only counts as empty upstream: Anthropic answers a marked "   "
// with the same non-retryable "cache_control cannot be set for empty text
// blocks" 400 it answers "" with.
const isMarkable = (m: Message | undefined): m is Message =>
    m !== undefined &&
    MARKABLE.has(m.role) &&
    typeof m.content === "string" &&
    m.content.trim().length > 0;

const findLastIndex = (
    messages: readonly Message[],
    pred: (m: Message | undefined) => boolean,
): number => {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (pred(messages[i])) return i;
    }
    return -1;
};

const mark = (m: Message): WireMessage => ({
    ...m,
    content: [{ type: "text", text: m.content as string, cache_control: { type: "ephemeral" } }],
});

// Two breakpoints, well under OpenRouter's limit of four:
//
//   1. The last system message. Anthropic's cache prefix runs tools → system →
//      messages, so this one marker covers the tool schemas too — the largest
//      static block Ye sends, and the one it re-sends verbatim every turn.
//   2. The tail. Each turn writes the delta behind it and reads everything
//      before, which is the incremental pattern Anthropic documents and the
//      one the native provider already uses.
export const applyCacheControl = (
    model: string,
    messages: readonly Message[],
): readonly WireMessage[] => {
    if (!needsExplicitCacheBreakpoints(model)) return messages;

    const targets = new Set<number>();
    const lastSystem = findLastIndex(messages, (m) => isMarkable(m) && m?.role === "system");
    if (lastSystem >= 0) targets.add(lastSystem);
    const tail = findLastIndex(messages, isMarkable);
    if (tail >= 0) targets.add(tail);
    if (targets.size === 0) return messages;

    return messages.map((m, i) => (targets.has(i) ? mark(m) : m));
};
