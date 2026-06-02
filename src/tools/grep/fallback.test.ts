import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepFallback } from "./fallback.ts";

let workDir: string;
const signal = new AbortController().signal;

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-grep-fb-"));
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("grepFallback", () => {
    test("F1 content mode returns path:line:text across a dir", async () => {
        await writeFile(join(workDir, "a.ts"), "alpha\nneedle here\ngamma\n", "utf8");
        await writeFile(join(workDir, "b.ts"), "no match\n", "utf8");
        const out = await grepFallback({
            pattern: "needle",
            root: workDir,
            mode: "content",
            signal,
        });
        expect(out).toBe("a.ts:2:needle here");
    });

    test("F2 no matches returns empty string", async () => {
        await writeFile(join(workDir, "a.ts"), "alpha\nbeta\n", "utf8");
        const out = await grepFallback({
            pattern: "absent",
            root: workDir,
            mode: "content",
            signal,
        });
        expect(out).toBe("");
    });

    test("F3 files_with_matches lists each matching file once", async () => {
        await writeFile(join(workDir, "a.ts"), "hit\nhit\n", "utf8");
        await writeFile(join(workDir, "b.ts"), "hit\n", "utf8");
        await writeFile(join(workDir, "c.ts"), "none\n", "utf8");
        const out = await grepFallback({
            pattern: "hit",
            root: workDir,
            mode: "files_with_matches",
            signal,
        });
        expect(out.split("\n").sort()).toEqual(["a.ts", "b.ts"]);
    });

    test("F4 count mode reports per-file match counts", async () => {
        await writeFile(join(workDir, "a.ts"), "x\nx\nx\n", "utf8");
        const out = await grepFallback({ pattern: "x", root: workDir, mode: "count", signal });
        expect(out).toBe("a.ts:3");
    });

    test("F5 type filter restricts by extension", async () => {
        await writeFile(join(workDir, "a.ts"), "match\n", "utf8");
        await writeFile(join(workDir, "a.py"), "match\n", "utf8");
        const out = await grepFallback({
            pattern: "match",
            root: workDir,
            mode: "files_with_matches",
            type: "py",
            signal,
        });
        expect(out).toBe("a.py");
    });

    test("F6 glob filter restricts by bare pattern anywhere in tree", async () => {
        await mkdir(join(workDir, "sub"), { recursive: true });
        await writeFile(join(workDir, "sub", "deep.md"), "find\n", "utf8");
        await writeFile(join(workDir, "top.ts"), "find\n", "utf8");
        const out = await grepFallback({
            pattern: "find",
            root: workDir,
            mode: "files_with_matches",
            glob: "*.md",
            signal,
        });
        expect(out).toBe(join("sub", "deep.md"));
    });

    test("F7 skips node_modules", async () => {
        await mkdir(join(workDir, "node_modules"), { recursive: true });
        await writeFile(join(workDir, "node_modules", "dep.ts"), "secret\n", "utf8");
        await writeFile(join(workDir, "src.ts"), "secret\n", "utf8");
        const out = await grepFallback({
            pattern: "secret",
            root: workDir,
            mode: "files_with_matches",
            signal,
        });
        expect(out).toBe("src.ts");
    });

    test("F8 single-file root omits the path prefix", async () => {
        const file = join(workDir, "solo.ts");
        await writeFile(file, "one\ntwo needle\n", "utf8");
        const out = await grepFallback({ pattern: "needle", root: file, mode: "content", signal });
        expect(out).toBe("2:two needle");
    });

    test("F9 invalid regex throws", async () => {
        await writeFile(join(workDir, "a.ts"), "x\n", "utf8");
        await expect(
            grepFallback({ pattern: "(", root: workDir, mode: "content", signal }),
        ).rejects.toThrow(/invalid regex/);
    });
});
