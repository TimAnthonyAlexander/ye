import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaySessionFile } from "./replay.ts";

let workDir: string;

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-replay-"));
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

const writeJsonl = async (events: ReadonlyArray<Record<string, unknown>>): Promise<string> => {
    const path = join(workDir, "session.jsonl");
    const lines = events.map((e) => JSON.stringify(e)).join("\n");
    await writeFile(path, `${lines}\n`, "utf8");
    return path;
};

describe("replaySessionFile", () => {
    test("rebuilds a simple user→assistant exchange", async () => {
        const path = await writeJsonl([
            { type: "user.message", content: "hello" },
            { type: "turn.start", turnIndex: 0 },
            { type: "model.text", delta: "hi " },
            { type: "model.text", delta: "there" },
            { type: "turn.end", stopReason: "end_turn" },
        ]);
        const out = await replaySessionFile(path);
        expect(out.history.length).toBe(2);
        expect(out.history[0]).toEqual({ role: "user", content: "hello" });
        expect(out.history[1]).toEqual({ role: "assistant", content: "hi there" });
        expect(out.turnsCompleted).toBe(1);
    });

    test("reattaches reasoning_details to the assistant message", async () => {
        const details = [
            {
                type: "reasoning.text",
                text: "Step 1: think",
                format: "anthropic-claude-v1",
                index: 0,
                signature: "sig-1",
            },
        ] as const;
        const path = await writeJsonl([
            { type: "user.message", content: "hi" },
            { type: "turn.start", turnIndex: 0 },
            { type: "model.reasoningDetails", details },
            { type: "model.text", delta: "hello" },
            { type: "turn.end", stopReason: "end_turn" },
        ]);
        const out = await replaySessionFile(path);
        expect(out.history[1]).toEqual({
            role: "assistant",
            content: "hello",
            reasoning_details: details,
        });
    });

    test("reasoning_details survive across multiple turns and tool calls", async () => {
        const detailsT1 = [{ type: "reasoning.text", text: "t1-thinking", index: 0 }] as const;
        const detailsT2 = [{ type: "reasoning.text", text: "t2-thinking", index: 0 }] as const;
        const path = await writeJsonl([
            { type: "user.message", content: "do it" },
            { type: "turn.start", turnIndex: 0 },
            { type: "model.reasoningDetails", details: detailsT1 },
            {
                type: "model.toolCall",
                id: "t1",
                name: "Read",
                args: { path: "/tmp/a" },
            },
            { type: "tool.start", id: "t1", name: "Read", args: { path: "/tmp/a" } },
            {
                type: "tool.end",
                id: "t1",
                name: "Read",
                result: { ok: true, value: "contents" },
            },
            { type: "turn.end", stopReason: "continue" },
            { type: "turn.start", turnIndex: 1 },
            { type: "model.reasoningDetails", details: detailsT2 },
            { type: "model.text", delta: "done" },
            { type: "turn.end", stopReason: "end_turn" },
        ]);
        const out = await replaySessionFile(path);
        const assistants = out.history.filter((m) => m.role === "assistant");
        expect(assistants).toHaveLength(2);
        expect(assistants[0]?.reasoning_details).toEqual(detailsT1);
        expect(assistants[1]?.reasoning_details).toEqual(detailsT2);
    });

    test("rewind truncates assistant messages including their reasoning_details", async () => {
        const path = await writeJsonl([
            { type: "user.message", content: "first" },
            {
                type: "prompt.start",
                firstTurnGlobalIdx: 1,
                preview: "first",
                ts: "2025-01-01T00:00:00Z",
            },
            { type: "turn.start", turnIndex: 0 },
            {
                type: "model.reasoningDetails",
                details: [{ type: "reasoning.text", text: "keep me", index: 0 }],
            },
            { type: "model.text", delta: "first answer" },
            { type: "turn.end", stopReason: "end_turn" },
            { type: "user.message", content: "second" },
            {
                type: "prompt.start",
                firstTurnGlobalIdx: 2,
                preview: "second",
                ts: "2025-01-01T00:00:01Z",
            },
            { type: "turn.start", turnIndex: 1 },
            {
                type: "model.reasoningDetails",
                details: [{ type: "reasoning.text", text: "drop me", index: 0 }],
            },
            { type: "model.text", delta: "second answer" },
            { type: "turn.end", stopReason: "end_turn" },
            { type: "rewind", upToPrompt: 1, firstTurnGlobalIdx: 2 },
            { type: "user.message", content: "redo" },
        ]);
        const out = await replaySessionFile(path);
        // After rewind: only the first user→assistant exchange survives, plus
        // the post-rewind user message.
        const assistants = out.history.filter((m) => m.role === "assistant");
        expect(assistants).toHaveLength(1);
        expect((assistants[0]?.reasoning_details ?? [])[0]).toMatchObject({ text: "keep me" });
    });

    test("rebuilds a turn with tool calls and results", async () => {
        const path = await writeJsonl([
            { type: "user.message", content: "read the file" },
            { type: "turn.start", turnIndex: 0 },
            {
                type: "model.toolCall",
                id: "t1",
                name: "Read",
                args: { path: "/tmp/foo" },
            },
            { type: "tool.start", id: "t1", name: "Read", args: { path: "/tmp/foo" } },
            {
                type: "tool.end",
                id: "t1",
                name: "Read",
                result: { ok: true, value: "file content" },
            },
            { type: "turn.end", stopReason: "continue" },
            { type: "turn.start", turnIndex: 1 },
            { type: "model.text", delta: "Done." },
            { type: "turn.end", stopReason: "end_turn" },
        ]);
        const out = await replaySessionFile(path);
        // user → assistant(tool_calls) → tool result → assistant("Done.")
        expect(out.history.length).toBe(4);
        expect(out.history[0]?.role).toBe("user");
        expect(out.history[1]?.role).toBe("assistant");
        expect(out.history[1]?.tool_calls?.length).toBe(1);
        expect(out.history[2]?.role).toBe("tool");
        expect(out.history[2]?.tool_call_id).toBe("t1");
        expect(out.history[3]).toEqual({ role: "assistant", content: "Done." });
        expect(out.toolCalls.length).toBe(1);
        expect(out.toolCalls[0]?.name).toBe("Read");
    });

    test("captures mode changes mid-session", async () => {
        const path = await writeJsonl([
            { type: "user.message", content: "plan it" },
            { type: "mode.changed", mode: "PLAN" },
            { type: "turn.end", stopReason: "end_turn" },
        ]);
        const out = await replaySessionFile(path);
        expect(out.mode).toBe("PLAN");
    });

    test("captures prompt boundaries and maxGlobalTurnIndex", async () => {
        const path = await writeJsonl([
            { type: "user.message", content: "first" },
            { type: "prompt.start", firstTurnGlobalIdx: 1, preview: "first" },
            { type: "turn.start", turnIndex: 0 },
            { type: "model.text", delta: "ok" },
            { type: "turn.end", stopReason: "end_turn" },
            { type: "user.message", content: "second" },
            { type: "prompt.start", firstTurnGlobalIdx: 2, preview: "second" },
            { type: "turn.start", turnIndex: 0 },
            { type: "model.text", delta: "done" },
            { type: "turn.end", stopReason: "end_turn" },
        ]);
        const out = await replaySessionFile(path);
        expect(out.prompts.length).toBe(2);
        expect(out.prompts[0]?.firstTurnGlobalIdx).toBe(1);
        expect(out.prompts[0]?.historyIdx).toBe(0);
        expect(out.prompts[1]?.firstTurnGlobalIdx).toBe(2);
        expect(out.prompts[1]?.historyIdx).toBe(2);
        expect(out.maxGlobalTurnIndex).toBe(2);
    });

    test("rewind event truncates history at the target prompt", async () => {
        const path = await writeJsonl([
            { type: "user.message", content: "first" },
            { type: "prompt.start", firstTurnGlobalIdx: 1, preview: "first" },
            { type: "turn.start", turnIndex: 0 },
            { type: "model.text", delta: "first answer" },
            { type: "turn.end", stopReason: "end_turn" },
            { type: "user.message", content: "second" },
            { type: "prompt.start", firstTurnGlobalIdx: 2, preview: "second" },
            { type: "turn.start", turnIndex: 0 },
            { type: "model.text", delta: "second answer" },
            { type: "turn.end", stopReason: "end_turn" },
            // Rewind back to before prompt #1 (the second one).
            { type: "rewind", upToPrompt: 1, firstTurnGlobalIdx: 2 },
            // New activity after rewind.
            { type: "user.message", content: "third (post-rewind)" },
            { type: "prompt.start", firstTurnGlobalIdx: 2, preview: "third" },
            { type: "turn.start", turnIndex: 0 },
            { type: "model.text", delta: "third answer" },
            { type: "turn.end", stopReason: "end_turn" },
        ]);
        const out = await replaySessionFile(path);
        // Should have: first user, first assistant, third user, third assistant.
        expect(out.history.length).toBe(4);
        expect(out.history[0]?.content).toBe("first");
        expect(out.history[1]?.content).toBe("first answer");
        expect(out.history[2]?.content).toBe("third (post-rewind)");
        expect(out.history[3]?.content).toBe("third answer");
        // prompts[] reflects the post-rewind set: prompt 0 (first) + post-
        // rewind prompt (newly assigned ordinal 1).
        expect(out.prompts.length).toBe(2);
    });

    test("captures the most recent session.title event", async () => {
        const path = await writeJsonl([
            { type: "user.message", content: "fix the login button" },
            { type: "session.title", title: "Fix login button" },
            { type: "model.text", delta: "ok" },
            { type: "turn.end", stopReason: "end_turn" },
        ]);
        const out = await replaySessionFile(path);
        expect(out.title).toBe("Fix login button");
    });

    test("returns null title when no session.title event present", async () => {
        const path = await writeJsonl([
            { type: "user.message", content: "hello" },
            { type: "turn.end", stopReason: "end_turn" },
        ]);
        const out = await replaySessionFile(path);
        expect(out.title).toBeNull();
    });

    test("ignores corrupted lines", async () => {
        const path = join(workDir, "corrupt.jsonl");
        await writeFile(
            path,
            `${JSON.stringify({ type: "user.message", content: "ok" })}\n` +
                "this is not json\n" +
                `${JSON.stringify({ type: "model.text", delta: "yes" })}\n` +
                `${JSON.stringify({ type: "turn.end", stopReason: "end_turn" })}\n`,
            "utf8",
        );
        const out = await replaySessionFile(path);
        expect(out.history.length).toBe(2);
        expect(out.history[0]?.content).toBe("ok");
        expect(out.history[1]?.content).toBe("yes");
    });
});
