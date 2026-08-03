import { describe, expect, it } from "bun:test";
import { parseUnifiedDiff, renderDiffLines } from "./diff.ts";

const SIMPLE = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,4 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    " const c = 4;",
    " const d = 5;",
    "",
].join("\n");

describe("parseUnifiedDiff", () => {
    it("returns nothing for an empty diff", () => {
        expect(parseUnifiedDiff("")).toEqual([]);
    });

    it("reads the path and the add/remove counts", () => {
        const files = parseUnifiedDiff(SIMPLE);
        expect(files).toHaveLength(1);
        expect(files[0]?.path).toBe("src/a.ts");
        expect(files[0]?.added).toBe(1);
        expect(files[0]?.removed).toBe(1);
    });

    it("keeps context, deletions and additions as segments", () => {
        const segments = parseUnifiedDiff(SIMPLE)[0]?.segments ?? [];
        expect(segments.map((s) => s.type)).toEqual(["eq", "del", "add", "eq", "eq"]);
        expect(segments[1]?.line).toBe("const b = 2;");
        expect(segments[2]?.line).toBe("const b = 3;");
    });

    it("does not mistake the ---/+++ headers for changed lines", () => {
        const lines = parseUnifiedDiff(SIMPLE)[0]?.segments.map((s) => s.line) ?? [];
        expect(lines.some((line) => line.startsWith("++ b/"))).toBe(false);
        expect(lines.some((line) => line.startsWith("-- a/"))).toBe(false);
    });

    it("collapses the untouched run between two hunks", () => {
        const raw = [
            "diff --git a/x.ts b/x.ts",
            "--- a/x.ts",
            "+++ b/x.ts",
            "@@ -1,2 +1,2 @@",
            " one",
            "-two",
            "@@ -40,2 +40,3 @@",
            " forty",
            "+forty-one",
            "",
        ].join("\n");
        const segments = parseUnifiedDiff(raw)[0]?.segments ?? [];
        const gap = segments.find((s) => s.type === "gap");
        expect(gap?.line).toBe("… 37 unchanged lines");
    });

    it("splits multiple files", () => {
        const raw = `${SIMPLE}${[
            "diff --git a/src/b.ts b/src/b.ts",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/src/b.ts",
            "@@ -0,0 +1,2 @@",
            "+hello",
            "+world",
            "",
        ].join("\n")}`;
        const files = parseUnifiedDiff(raw);
        expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
        expect(files[1]?.note).toBe("new file");
        expect(files[1]?.added).toBe(2);
    });

    it("names a deleted file from its old path", () => {
        const raw = [
            "diff --git a/gone.ts b/gone.ts",
            "deleted file mode 100644",
            "--- a/gone.ts",
            "+++ /dev/null",
            "@@ -1,1 +0,0 @@",
            "-bye",
            "",
        ].join("\n");
        const file = parseUnifiedDiff(raw)[0];
        expect(file?.path).toBe("gone.ts");
        expect(file?.note).toBe("deleted");
        expect(file?.removed).toBe(1);
    });

    it("marks a binary file without inventing line counts", () => {
        const raw = [
            "diff --git a/logo.png b/logo.png",
            "index 111..222 100644",
            "Binary files a/logo.png and b/logo.png differ",
            "",
        ].join("\n");
        const file = parseUnifiedDiff(raw)[0];
        expect(file?.path).toBe("logo.png");
        expect(file?.note).toBe("binary");
        expect(file?.added).toBe(0);
        expect(file?.segments).toEqual([]);
    });
});

describe("renderDiffLines", () => {
    it("heads the output with a per-diff summary", () => {
        const lines = renderDiffLines(parseUnifiedDiff(SIMPLE));
        expect(lines[0]).toEqual({ kind: "title", text: "1 file changed, +1 -1" });
    });

    it("puts a summary header on each file", () => {
        const lines = renderDiffLines(parseUnifiedDiff(SIMPLE));
        expect(lines.find((l) => l.kind === "file")?.text).toBe("  src/a.ts  +1 -1");
    });

    it("uses the edit-diff conventions for the body", () => {
        const lines = renderDiffLines(parseUnifiedDiff(SIMPLE));
        expect(lines.find((l) => l.kind === "del")?.text).toBe("    - const b = 2;");
        expect(lines.find((l) => l.kind === "add")?.text).toBe("    + const b = 3;");
        expect(lines.filter((l) => l.kind === "context")[0]?.text).toBe("      const a = 1;");
    });

    it("elides a file that is longer than the per-file cap and says so", () => {
        const body = Array.from({ length: 30 }, (_, i) => `+line ${i}`);
        const raw = [
            "diff --git a/big.ts b/big.ts",
            "--- a/big.ts",
            "+++ b/big.ts",
            "@@ -0,0 +1,30 @@",
            ...body,
            "",
        ].join("\n");
        const lines = renderDiffLines(parseUnifiedDiff(raw), { maxFileLines: 5 });
        expect(lines.filter((l) => l.kind === "add")).toHaveLength(5);
        expect(lines.at(-1)?.text).toBe("    … 25 lines elided");
    });

    it("stops emitting files once the total cap is spent", () => {
        const file = (n: number): string =>
            [
                `diff --git a/f${n}.ts b/f${n}.ts`,
                `--- a/f${n}.ts`,
                `+++ b/f${n}.ts`,
                "@@ -1,1 +1,2 @@",
                " keep",
                "+add",
            ].join("\n");
        const raw = `${[0, 1, 2, 3, 4].map(file).join("\n")}\n`;
        const lines = renderDiffLines(parseUnifiedDiff(raw), { maxTotalLines: 6 });
        expect(lines.filter((l) => l.kind === "file")).toHaveLength(2);
        expect(lines.at(-1)?.text).toBe("… 3 files not shown");
    });

    it("names untracked files, capped", () => {
        const untracked = Array.from({ length: 13 }, (_, i) => `new-${i}.ts`);
        const lines = renderDiffLines(parseUnifiedDiff(SIMPLE), { untracked });
        const last = lines.at(-1);
        expect(last?.kind).toBe("meta");
        expect(last?.text).toContain("untracked: new-0.ts");
        expect(last?.text).toContain("+3 more");
    });
});
