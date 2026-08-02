import { describe, expect, test } from "bun:test";
import type { Event } from "../pipeline/events.ts";
import { errorSummary, formatSummary, streamEventLine, type RunSummary } from "./output.ts";

const summary: RunSummary = {
    ok: true,
    result: "done",
    stopReason: "end_turn",
    sessionId: "sess-1",
    projectId: "proj-1",
    model: "some/model",
    provider: "openrouter",
    turns: 2,
    usage: { inputTokens: 10, outputTokens: 3, cachedTokens: 1, costUsd: 0.5 },
    durationMs: 42,
};

describe("formatSummary", () => {
    test("json mode emits the summary verbatim", () => {
        expect(JSON.parse(formatSummary("json", summary))).toEqual(summary);
    });

    test("stream-json mode tags the summary line", () => {
        const parsed: unknown = JSON.parse(formatSummary("stream-json", summary));
        expect(parsed).toEqual({ type: "result", ...summary });
    });

    test("errorSummary carries the message and stays parseable", () => {
        const parsed: unknown = JSON.parse(formatSummary("json", errorSummary("boom")));
        expect(parsed).toMatchObject({ ok: false, stopReason: "error", error: "boom" });
    });
});

describe("streamEventLine", () => {
    test("serialises the streamed event types", () => {
        const events: readonly Event[] = [
            { type: "turn.start", turnIndex: 0 },
            { type: "model.text", delta: "hi" },
            { type: "tool.start", id: "t1", name: "Read", args: { file_path: "/tmp/a" } },
            { type: "tool.end", id: "t1", name: "Read", result: { ok: true, value: "x" } },
            { type: "shaper.applied", name: "snip", tokensFreed: 12 },
            { type: "recovery.retry", attempt: 1, kind: "network", action: "backoff", waitMs: 500 },
            { type: "turn.end", stopReason: "end_turn" },
        ];
        for (const event of events) {
            const line = streamEventLine(event);
            expect(line).not.toBeNull();
            const parsed = JSON.parse(line as string) as { type: string };
            expect(parsed.type).toBe(event.type);
            expect(line).not.toContain("\n");
        }
    });

    test("drops events that carry callbacks or are not part of the contract", () => {
        const prompt: Event = {
            type: "userQuestion.prompt",
            id: "q1",
            payload: { question: "?", options: [], multiSelect: false },
            respond: () => {},
        };
        expect(streamEventLine(prompt)).toBeNull();
        expect(streamEventLine({ type: "mode.changed", mode: "PLAN" })).toBeNull();
        expect(streamEventLine({ type: "model.reasoning", delta: "hmm" })).toBeNull();
    });

    test("falls back to a well-formed line when the payload is not serialisable", () => {
        const circular: { self?: unknown } = {};
        circular.self = circular;
        const line = streamEventLine({
            type: "tool.end",
            id: "t1",
            name: "Bash",
            result: { ok: true, value: circular },
        });
        expect(line).toBe('{"type":"tool.end"}');
    });
});
