import { describe, expect, test } from "bun:test";
import { computeEditDiff, type DiffSegment } from "./editDiff.ts";

const segs = (...s: DiffSegment[]): readonly DiffSegment[] => s;

describe("computeEditDiff — basic shapes", () => {
    test("pure addition at end keeps original lines as eq context", () => {
        const out = computeEditDiff("a\nb", "a\nb\nc");
        expect(out.truncated).toBe(false);
        expect(out.segments).toEqual(
            segs({ type: "eq", line: "a" }, { type: "eq", line: "b" }, { type: "add", line: "c" }),
        );
    });

    test("pure deletion keeps surviving lines as eq context", () => {
        const out = computeEditDiff("a\nb\nc", "a\nc");
        expect(out.segments).toEqual(
            segs({ type: "eq", line: "a" }, { type: "del", line: "b" }, { type: "eq", line: "c" }),
        );
    });

    test("single-line replace shows del then add, no surrounding context invented", () => {
        const out = computeEditDiff("x", "y");
        expect(out.segments).toEqual(segs({ type: "del", line: "x" }, { type: "add", line: "y" }));
    });

    test("inserting a line in the middle does NOT re-emit unchanged neighbors as -/+", () => {
        const oldStr = "let a;\nlet b;\nlet c;";
        const newStr = "let a;\nlet b;\nlet NEW;\nlet c;";
        const out = computeEditDiff(oldStr, newStr);
        expect(out.segments).toEqual(
            segs(
                { type: "eq", line: "let a;" },
                { type: "eq", line: "let b;" },
                { type: "add", line: "let NEW;" },
                { type: "eq", line: "let c;" },
            ),
        );
    });
});

describe("computeEditDiff — context windows and gap collapsing", () => {
    test("collapses runs of unchanged lines outside the context window", () => {
        // 11 unchanged lines, 1 changed at the start; context=3 keeps lines 0-3
        // and the rest collapses to a gap.
        const oldLines = ["A", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
        const newLines = ["B", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
        const out = computeEditDiff(oldLines.join("\n"), newLines.join("\n"), {
            context: 3,
        });
        expect(out.segments).toEqual(
            segs(
                { type: "del", line: "A" },
                { type: "add", line: "B" },
                { type: "eq", line: "1" },
                { type: "eq", line: "2" },
                { type: "eq", line: "3" },
                { type: "gap", line: "… 7 unchanged lines" },
            ),
        );
    });

    test("singular gap message uses 'line' not 'lines'", () => {
        const oldLines = ["A", "1", "2", "3", "4"];
        const newLines = ["B", "1", "2", "3", "4"];
        const out = computeEditDiff(oldLines.join("\n"), newLines.join("\n"), {
            context: 3,
        });
        expect(out.segments.at(-1)).toEqual({
            type: "gap",
            line: "… 1 unchanged line",
        });
    });

    test("context=0 emits only the changed lines", () => {
        const oldStr = "a\nb\nc\nd\ne";
        const newStr = "a\nb\nX\nd\ne";
        const out = computeEditDiff(oldStr, newStr, { context: 0 });
        expect(out.segments).toEqual(
            segs(
                { type: "gap", line: "… 2 unchanged lines" },
                { type: "del", line: "c" },
                { type: "add", line: "X" },
                { type: "gap", line: "… 2 unchanged lines" },
            ),
        );
    });
});

describe("computeEditDiff — truncation", () => {
    test("truncates to maxLines when output exceeds budget", () => {
        const oldLines = Array.from({ length: 30 }, (_, i) => `old-${i}`);
        const newLines = Array.from({ length: 30 }, (_, i) => `new-${i}`);
        const out = computeEditDiff(oldLines.join("\n"), newLines.join("\n"), {
            maxLines: 6,
        });
        expect(out.truncated).toBe(true);
        expect(out.segments.length).toBe(6);
    });

    test("no truncation flag when within budget", () => {
        const out = computeEditDiff("a\nb", "a\nB", { maxLines: 20 });
        expect(out.truncated).toBe(false);
    });
});

describe("computeEditDiff — regression: shared-prefix duplication bug", () => {
    test("inserting one line in a long run does not produce huge -/+ blocks of duplicate context", () => {
        // Mirrors the user's cli.tsx case: identical leading context plus one
        // new line. Old behavior dumped both old_string and new_string in
        // full as -/+ — confirm the new diff doesn't.
        const shared = [
            "let resume = false;",
            "let resumeSessionId: string | null = null;",
            "let update = false;",
            "let prompt: string | null = null;",
        ];
        const tail = [
            "for (let i = 0; i < argv.length; i++) {",
            "    const a = argv[i];",
            '    if (a === "--resume") {',
        ];
        const oldStr = [...shared, ...tail].join("\n");
        const newStr = [...shared, "let mode: string | null = null;", ...tail].join("\n");
        const out = computeEditDiff(oldStr, newStr);
        const dels = out.segments.filter((s) => s.type === "del");
        const adds = out.segments.filter((s) => s.type === "add");
        expect(dels.length).toBe(0);
        expect(adds).toEqual([{ type: "add", line: "let mode: string | null = null;" }]);
    });
});
