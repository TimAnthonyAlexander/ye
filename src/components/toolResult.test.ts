import { describe, expect, test } from "bun:test";
import {
    collapsedResultText,
    expandedResultLines,
    RESULT_CLIP_CHARS,
    VERBOSE_MAX_CHARS,
    VERBOSE_MAX_LINES,
} from "./toolResult.ts";

describe("collapsedResultText", () => {
    test("successful results stay silent", () => {
        expect(collapsedResultText({ ok: true, value: "lots of output" })).toBe("");
    });

    test("no result at all is empty", () => {
        expect(collapsedResultText(undefined)).toBe("");
    });

    test("a short error is shown whole", () => {
        expect(collapsedResultText({ ok: false, error: "boom" })).toBe("boom");
    });

    test("a long error is clipped with an ellipsis", () => {
        const out = collapsedResultText({ ok: false, error: "x".repeat(500) });
        expect(out).toBe(`${"x".repeat(RESULT_CLIP_CHARS)}…`);
    });

    test("an error exactly at the clip is not marked truncated", () => {
        const error = "x".repeat(RESULT_CLIP_CHARS);
        expect(collapsedResultText({ ok: false, error })).toBe(error);
    });
});

describe("expandedResultLines", () => {
    test("nothing to show for a missing or empty result", () => {
        expect(expandedResultLines(undefined)).toEqual([]);
        expect(expandedResultLines({ ok: true, value: "" })).toEqual([]);
        expect(expandedResultLines({ ok: true, value: "   \n  " })).toEqual([]);
    });

    test("a successful result is shown in full", () => {
        expect(expandedResultLines({ ok: true, value: "a\nb\nc" })).toEqual(["a", "b", "c"]);
    });

    test("an error is shown past the collapsed clip", () => {
        const error = `${"x".repeat(RESULT_CLIP_CHARS)}TAIL`;
        expect(expandedResultLines({ ok: false, error })).toEqual([error]);
    });

    test("non-string values have nothing to render", () => {
        expect(expandedResultLines({ ok: true, value: { a: 1 } })).toEqual([]);
    });

    test("trailing blank lines are trimmed", () => {
        expect(expandedResultLines({ ok: true, value: "a\nb\n\n\n" })).toEqual(["a", "b"]);
    });

    test("line count is capped with an explicit marker", () => {
        const value = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
        const out = expandedResultLines({ ok: true, value });
        expect(out.length).toBe(VERBOSE_MAX_LINES + 1);
        expect(out[VERBOSE_MAX_LINES - 1]).toBe(`line ${VERBOSE_MAX_LINES - 1}`);
        expect(out[VERBOSE_MAX_LINES]).toBe(`… ${250 - VERBOSE_MAX_LINES} more lines`);
    });

    test("one dropped line is singular", () => {
        const value = Array.from({ length: VERBOSE_MAX_LINES + 1 }, (_, i) => `l${i}`).join("\n");
        const out = expandedResultLines({ ok: true, value });
        expect(out[out.length - 1]).toBe("… 1 more line");
    });

    test("a huge single line is truncated and says so", () => {
        const out = expandedResultLines({ ok: true, value: "y".repeat(VERBOSE_MAX_CHARS * 3) });
        expect(out.length).toBe(2);
        expect(out[0]?.length).toBe(VERBOSE_MAX_CHARS);
        expect(out[1]).toBe("… truncated");
    });

    test("a megabyte of output stays bounded", () => {
        const value = Array.from({ length: 20_000 }, (_, i) => `row ${i} ${"z".repeat(50)}`).join(
            "\n",
        );
        const out = expandedResultLines({ ok: true, value });
        expect(out.length).toBeLessThanOrEqual(VERBOSE_MAX_LINES + 1);
        expect(out.join("\n").length).toBeLessThanOrEqual(VERBOSE_MAX_CHARS + 64);
        expect(out[out.length - 1]).toMatch(/^… \d+ more lines$/);
    });
});
