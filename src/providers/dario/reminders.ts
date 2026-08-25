import type { Message } from "../types.ts";

// dario scrubs a list of "orchestration tags" out of every outbound request —
// `<system-reminder>` among them (ORCHESTRATION_TAG_NAMES in its proxy.js).
// Ye's history is full of them: git status, background task and monitor
// notices, verify failures, lazily-loaded subdirectory notes, the plan and
// ghost-wait nudges. Through dario none of it ever reached the model, and a
// message that was *only* a reminder reached Anthropic as an empty text block
// with Ye's cache breakpoint still on it:
//
//   400 messages.N.content.0.text: cache_control cannot be set for empty text
//       blocks                                          (non-retryable, kills the turn)
//
// dario has a `--preserve-orchestration-tags` opt-out, but it is set on the
// daemon at startup and the user may be running their own proxy, so Ye cannot
// rely on it. Renaming the tag is what Ye controls: same framing for the model,
// no name on dario's scrub list.
const OPEN = /<system-reminder>/g;
const CLOSE = /<\/system-reminder>/g;

export const DARIO_REMINDER_TAG = "system-note";

export const rewriteReminderTags = (text: string): string =>
    text.includes("<system-reminder>") || text.includes("</system-reminder>")
        ? text.replace(OPEN, `<${DARIO_REMINDER_TAG}>`).replace(CLOSE, `</${DARIO_REMINDER_TAG}>`)
        : text;

export const rewriteReminders = (messages: readonly Message[]): readonly Message[] => {
    let changed = false;
    const out = messages.map((m) => {
        if (typeof m.content !== "string") return m;
        const rewritten = rewriteReminderTags(m.content);
        if (rewritten === m.content) return m;
        changed = true;
        return { ...m, content: rewritten };
    });
    return changed ? out : messages;
};
