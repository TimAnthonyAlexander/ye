import { describe, expect, test } from "bun:test";
import type { Message } from "../types.ts";
import { DARIO_REMINDER_TAG, rewriteReminderTags, rewriteReminders } from "./reminders.ts";

describe("rewriteReminderTags", () => {
    test("renames both halves of the tag and keeps the body verbatim", () => {
        const out = rewriteReminderTags("<system-reminder>\ngit status clean\n</system-reminder>");
        expect(out).toBe(`<${DARIO_REMINDER_TAG}>\ngit status clean\n</${DARIO_REMINDER_TAG}>`);
    });

    test("rewrites every reminder in a message, not just the first", () => {
        const out = rewriteReminderTags(
            "<system-reminder>a</system-reminder>\n<system-reminder>b</system-reminder>",
        );
        expect(out).not.toContain("system-reminder");
        expect(out).toContain("a");
        expect(out).toContain("b");
    });

    test("text without a reminder is returned unchanged", () => {
        const text = "just a prompt about <div> and </html>";
        expect(rewriteReminderTags(text)).toBe(text);
    });
});

describe("rewriteReminders", () => {
    test("only the messages carrying a reminder are rebuilt", () => {
        const plain: Message = { role: "user", content: "hello" };
        const messages: readonly Message[] = [
            plain,
            { role: "user", content: "<system-reminder>x</system-reminder>" },
        ];
        const out = rewriteReminders(messages);
        expect(out[0]).toBe(plain);
        expect(out[1]?.content).toBe(`<${DARIO_REMINDER_TAG}>x</${DARIO_REMINDER_TAG}>`);
    });

    test("a history with no reminders is returned as the same array", () => {
        const messages: readonly Message[] = [
            { role: "user", content: "hello" },
            { role: "assistant", content: null, tool_calls: [] },
        ];
        expect(rewriteReminders(messages)).toBe(messages);
    });

    test("null content and tool metadata survive untouched", () => {
        const out = rewriteReminders([
            { role: "assistant", content: null },
            { role: "tool", tool_call_id: "t1", content: "<system-reminder>y</system-reminder>" },
        ]);
        expect(out[0]?.content).toBeNull();
        expect(out[1]?.tool_call_id).toBe("t1");
        expect(out[1]?.content).not.toContain("system-reminder");
    });
});
