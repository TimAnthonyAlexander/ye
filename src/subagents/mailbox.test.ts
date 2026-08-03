import { describe, expect, test } from "bun:test";
import { SubagentMailbox, type MailboxMessage } from "./mailbox.ts";

describe("SubagentMailbox", () => {
    describe("enqueue", () => {
        test("queues a message and reports it back", () => {
            const mailbox = new SubagentMailbox();
            const result = mailbox.enqueue("go left instead");
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error("unreachable");
            expect(result.message.text).toBe("go left instead");
            expect(result.message.status).toBe("queued");
        });

        test("trims surrounding whitespace", () => {
            const mailbox = new SubagentMailbox();
            const result = mailbox.enqueue("  stop editing tests  ");
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error("unreachable");
            expect(result.message.text).toBe("stop editing tests");
        });

        test("refuses an empty message", () => {
            const mailbox = new SubagentMailbox();
            const result = mailbox.enqueue("   ");
            expect(result.ok).toBe(false);
            if (result.ok) throw new Error("unreachable");
            expect(result.error).toContain("empty");
            expect(mailbox.queued()).toHaveLength(0);
        });

        test("mints distinct ids", () => {
            const mailbox = new SubagentMailbox();
            const a = mailbox.enqueue("one");
            const b = mailbox.enqueue("two");
            if (!a.ok || !b.ok) throw new Error("unreachable");
            expect(a.message.id).not.toBe(b.message.id);
        });

        test("preserves order across several messages", () => {
            const mailbox = new SubagentMailbox();
            mailbox.enqueue("first");
            mailbox.enqueue("second");
            mailbox.enqueue("third");
            expect(mailbox.queued().map((m) => m.text)).toEqual(["first", "second", "third"]);
        });
    });

    describe("drain", () => {
        test("returns queued messages and marks them delivered", () => {
            const mailbox = new SubagentMailbox();
            mailbox.enqueue("first");
            mailbox.enqueue("second");
            const drained = mailbox.drain();
            expect(drained.map((m) => m.text)).toEqual(["first", "second"]);
            expect(drained.every((m) => m.status === "delivered")).toBe(true);
            expect(mailbox.queued()).toHaveLength(0);
        });

        test("a second drain returns nothing — a message is delivered once", () => {
            const mailbox = new SubagentMailbox();
            mailbox.enqueue("only once");
            expect(mailbox.drain()).toHaveLength(1);
            expect(mailbox.drain()).toHaveLength(0);
        });

        test("draining an empty mailbox is a no-op", () => {
            const mailbox = new SubagentMailbox();
            expect(mailbox.drain()).toHaveLength(0);
            expect(mailbox.hasQueued()).toBe(false);
        });

        test("fires onDelivered once per message, after every status has flipped", () => {
            const seen: string[] = [];
            const mailbox: SubagentMailbox = new SubagentMailbox({
                onDelivered: (message: MailboxMessage) => {
                    seen.push(message.text);
                    expect(mailbox.hasQueued()).toBe(false);
                },
            });
            mailbox.enqueue("a");
            mailbox.enqueue("b");
            mailbox.drain();
            expect(seen).toEqual(["a", "b"]);
        });

        test("a message queued after a drain is picked up by the next one", () => {
            const mailbox = new SubagentMailbox();
            mailbox.enqueue("early");
            mailbox.drain();
            mailbox.enqueue("late");
            expect(mailbox.drain().map((m) => m.text)).toEqual(["late"]);
        });
    });

    describe("hasQueued", () => {
        test("is false before anything is enqueued and true after", () => {
            const mailbox = new SubagentMailbox();
            expect(mailbox.hasQueued()).toBe(false);
            mailbox.enqueue("something");
            expect(mailbox.hasQueued()).toBe(true);
        });

        test("does not consume — the message is still drainable", () => {
            const mailbox = new SubagentMailbox();
            mailbox.enqueue("still here");
            expect(mailbox.hasQueued()).toBe(true);
            expect(mailbox.drain()).toHaveLength(1);
        });
    });

    describe("close", () => {
        test("refuses a message sent to a finished agent, with the reason", () => {
            const mailbox = new SubagentMailbox();
            mailbox.close("the subagent already finished");
            const result = mailbox.enqueue("too late");
            expect(result.ok).toBe(false);
            if (result.ok) throw new Error("unreachable");
            expect(result.error).toContain("already finished");
        });

        test("rejects messages that were queued but never drained", () => {
            const mailbox = new SubagentMailbox();
            mailbox.enqueue("in flight");
            mailbox.close("the subagent was stopped");
            expect(mailbox.queued()).toHaveLength(0);
            const rejected = mailbox.rejected();
            expect(rejected).toHaveLength(1);
            expect(rejected[0]!.text).toBe("in flight");
            expect(rejected[0]!.rejection).toContain("was stopped");
        });

        test("leaves already-delivered messages alone", () => {
            const mailbox = new SubagentMailbox();
            mailbox.enqueue("landed");
            mailbox.drain();
            mailbox.close("the subagent already finished");
            expect(mailbox.rejected()).toHaveLength(0);
            expect(mailbox.messages()[0]!.status).toBe("delivered");
        });

        test("a rejected message is never silently dropped — it stays in the log", () => {
            const mailbox = new SubagentMailbox();
            mailbox.enqueue("never read");
            mailbox.close("the subagent failed");
            expect(mailbox.messages()).toHaveLength(1);
        });

        test("the first reason wins — a second close does not overwrite it", () => {
            const mailbox = new SubagentMailbox();
            mailbox.close("the subagent was stopped");
            mailbox.close("the subagent already finished");
            const result = mailbox.enqueue("hello");
            if (result.ok) throw new Error("unreachable");
            expect(result.error).toContain("was stopped");
        });

        test("isClosed flips", () => {
            const mailbox = new SubagentMailbox();
            expect(mailbox.isClosed()).toBe(false);
            mailbox.close("done");
            expect(mailbox.isClosed()).toBe(true);
        });
    });

    describe("rejectQueued", () => {
        test("marks queued messages rejected without closing the mailbox", () => {
            const mailbox = new SubagentMailbox();
            mailbox.enqueue("at the ceiling");
            mailbox.rejectQueued("not delivered — the subagent stopped at its ceiling of 3 turns");
            expect(mailbox.rejected()[0]!.rejection).toContain("ceiling of 3 turns");
            expect(mailbox.isClosed()).toBe(false);
            expect(mailbox.enqueue("still open").ok).toBe(true);
        });

        test("is a no-op when nothing is queued", () => {
            const mailbox = new SubagentMailbox();
            mailbox.enqueue("delivered already");
            mailbox.drain();
            mailbox.rejectQueued("ceiling");
            expect(mailbox.rejected()).toHaveLength(0);
        });
    });
});
