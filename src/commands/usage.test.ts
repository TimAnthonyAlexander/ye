import { describe, expect, it } from "bun:test";
import { aggregateUsageWindows } from "../storage/usage.ts";
import { usageLines } from "./usage.ts";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

interface RecordOverrides {
    readonly at?: number;
    readonly provider?: string;
    readonly model?: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly costUsd?: number;
}

const record = (over: RecordOverrides = {}): string =>
    JSON.stringify({
        ts: new Date(over.at ?? NOW - HOUR).toISOString(),
        sessionId: "s1",
        projectId: "p1",
        provider: over.provider ?? "openrouter",
        model: over.model ?? "google/gemini-flash-latest",
        inputTokens: over.inputTokens ?? 1000,
        outputTokens: over.outputTokens ?? 200,
        cacheReadTokens: over.cacheReadTokens ?? 0,
        cacheCreationTokens: over.cacheCreationTokens ?? 0,
        costUsd: over.costUsd ?? 0.5,
        callKind: "turn",
    });

const jsonl = (...records: readonly string[]): string => `${records.join("\n")}\n`;

describe("aggregateUsageWindows", () => {
    it("returns empty windows for no data", () => {
        const windows = aggregateUsageWindows("", NOW);
        expect(windows.allTime.calls).toBe(0);
        expect(windows.day.calls).toBe(0);
        expect(windows.week.calls).toBe(0);
    });

    it("places a record in every window it is young enough for", () => {
        const windows = aggregateUsageWindows(jsonl(record({ at: NOW - 3 * HOUR })), NOW);
        expect(windows.day.calls).toBe(1);
        expect(windows.week.calls).toBe(1);
        expect(windows.allTime.calls).toBe(1);
    });

    it("excludes a three-day-old record from the day window only", () => {
        const windows = aggregateUsageWindows(jsonl(record({ at: NOW - 72 * HOUR })), NOW);
        expect(windows.day.calls).toBe(0);
        expect(windows.week.calls).toBe(1);
        expect(windows.allTime.calls).toBe(1);
    });

    it("keeps an ancient record in all time only", () => {
        const windows = aggregateUsageWindows(jsonl(record({ at: NOW - 400 * 24 * HOUR })), NOW);
        expect(windows.week.calls).toBe(0);
        expect(windows.allTime.calls).toBe(1);
    });

    it("counts an unparseable timestamp towards all time but no window", () => {
        const line = JSON.stringify({
            ts: "not a date",
            sessionId: "s1",
            provider: "openai",
            model: "gpt-5",
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.01,
        });
        const windows = aggregateUsageWindows(jsonl(line), NOW);
        expect(windows.allTime.calls).toBe(1);
        expect(windows.day.calls).toBe(0);
        expect(windows.week.calls).toBe(0);
    });

    it("splits totals by provider and by model", () => {
        const windows = aggregateUsageWindows(
            jsonl(
                record({ provider: "openrouter", model: "a", costUsd: 1, inputTokens: 100 }),
                record({ provider: "openrouter", model: "b", costUsd: 2, inputTokens: 200 }),
                record({ provider: "anthropic", model: "c", costUsd: 4, inputTokens: 300 }),
            ),
            NOW,
        );
        expect(windows.allTime.byProvider["openrouter"]?.costUsd).toBe(3);
        expect(windows.allTime.byProvider["openrouter"]?.inputTokens).toBe(300);
        expect(windows.allTime.byProvider["anthropic"]?.costUsd).toBe(4);
        expect(Object.keys(windows.allTime.byModel).sort()).toEqual(["a", "b", "c"]);
        expect(windows.allTime.costUsd).toBe(7);
    });

    it("sums cached reads into the breakdown", () => {
        const windows = aggregateUsageWindows(
            jsonl(record({ cacheReadTokens: 500 }), record({ cacheReadTokens: 1500 })),
            NOW,
        );
        expect(windows.allTime.byProvider["openrouter"]?.cacheReadTokens).toBe(2000);
    });

    it("skips malformed lines instead of failing", () => {
        const windows = aggregateUsageWindows(`{oops\n${record()}\n`, NOW);
        expect(windows.allTime.calls).toBe(1);
    });
});

describe("usageLines", () => {
    it("says so in one line when there is no data", () => {
        const lines = usageLines(aggregateUsageWindows("", NOW));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("No usage recorded yet");
    });

    it("shows all three windows", () => {
        const text = usageLines(aggregateUsageWindows(jsonl(record()), NOW)).join("\n");
        expect(text).toContain("Usage — last 24h");
        expect(text).toContain("Usage — last 7d");
        expect(text).toContain("Usage — all time");
    });

    it("reports a window with nothing in it rather than an empty table", () => {
        const text = usageLines(
            aggregateUsageWindows(jsonl(record({ at: NOW - 400 * 24 * HOUR })), NOW),
        ).join("\n");
        expect(text).toContain("Usage — last 24h\n  nothing recorded");
        expect(text).toContain("by provider");
    });

    it("sorts rows by cost descending", () => {
        const text = usageLines(
            aggregateUsageWindows(
                jsonl(
                    record({ provider: "cheap", model: "m-cheap", costUsd: 0.1 }),
                    record({ provider: "dear", model: "m-dear", costUsd: 9 }),
                    record({ provider: "mid", model: "m-mid", costUsd: 1 }),
                ),
                NOW,
            ),
        ).join("\n");
        const order = ["dear", "mid", "cheap"].map((name) => text.indexOf(`    ${name}`));
        expect(order[0]).toBeLessThan(order[1]!);
        expect(order[1]).toBeLessThan(order[2]!);
    });

    it("aligns the columns across every section", () => {
        const lines = usageLines(
            aggregateUsageWindows(
                jsonl(
                    record({ provider: "openrouter", model: "a-very-long-model-name-here" }),
                    record({ provider: "x", model: "b" }),
                ),
                NOW,
            ),
        );
        const rows = lines.filter((line) => line.includes("↑"));
        const columns = new Set(rows.map((line) => line.indexOf("↑")));
        expect(columns.size).toBe(1);
    });

    it("caps the number of rows in a section", () => {
        const many = Array.from({ length: 12 }, (_, i) =>
            record({ model: `model-${i}`, costUsd: i + 1 }),
        );
        const text = usageLines(aggregateUsageWindows(jsonl(...many), NOW)).join("\n");
        expect(text).toContain("(+4 more)");
    });

    it("shows a total line carrying the call count", () => {
        const text = usageLines(aggregateUsageWindows(jsonl(record(), record()), NOW)).join("\n");
        expect(text).toContain("total (2 calls)");
    });

    // Anthropic puts a cache write outside `input_tokens`, and Ye's own tail
    // breakpoint sits on the user's newest message, so a real turn reports
    // input_tokens: 2 with the whole prompt in cache_creation. Rendering
    // inputTokens alone showed ↑2 for a 58k request.
    it("counts cache-creation tokens as sent, not as cache hits", () => {
        const text = usageLines(
            aggregateUsageWindows(
                jsonl(
                    record({
                        provider: "dario",
                        model: "claude-opus-4-8",
                        inputTokens: 2,
                        cacheCreationTokens: 58_500,
                        cacheReadTokens: 0,
                    }),
                ),
                NOW,
            ),
        ).join("\n");
        expect(text).toContain("↑   59K");
        expect(text).not.toContain("↑     2");
    });
});
