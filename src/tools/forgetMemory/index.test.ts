import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { removeMemoryEntry } from "../../memory/memoryIndex.ts";
import { getProjectMemoryDir } from "../../storage/paths.ts";
import type { ToolContext } from "../types.ts";
import { ForgetMemoryTool } from "./index.ts";

// CONFIG_DIR is a module-level constant off homedir(), so the project id is
// what isolates this — the same convention as storage/checkpoints.test.ts.
const PROJECT = "forget-memory-test";
const memoryDir = (): string => getProjectMemoryDir(PROJECT);

const ctx = { projectId: PROJECT } as ToolContext;

beforeEach(async () => {
    await rm(memoryDir(), { recursive: true, force: true });
    await mkdir(memoryDir(), { recursive: true });
});

afterEach(async () => {
    await rm(join(memoryDir(), ".."), { recursive: true, force: true });
});

const seed = async (filename: string, index: string): Promise<void> => {
    await Bun.write(join(memoryDir(), filename), "body\n");
    await writeFile(join(memoryDir(), "MEMORY.md"), index);
};

describe("ForgetMemory", () => {
    test("F1 removes the file and its index line, by title", async () => {
        await seed(
            "throwaway_note.md",
            "- [Keep me](keep_me.md) — stays\n- [Throwaway note](throwaway_note.md) — goes\n",
        );

        const r = await ForgetMemoryTool.execute({ title: "Throwaway note" }, ctx);
        expect(r.ok).toBe(true);
        expect(r.ok === true && r.value.indexEntriesRemoved).toBe(1);
        expect(await Bun.file(join(memoryDir(), "throwaway_note.md")).exists()).toBe(false);
        expect(await readFile(join(memoryDir(), "MEMORY.md"), "utf8")).toBe(
            "- [Keep me](keep_me.md) — stays\n",
        );
    });

    test("F2 accepts the filename from the index as well", async () => {
        await seed("throwaway_note.md", "- [Throwaway note](throwaway_note.md) — goes\n");
        const r = await ForgetMemoryTool.execute({ title: "throwaway_note.md" }, ctx);
        expect(r.ok).toBe(true);
        expect(await Bun.file(join(memoryDir(), "throwaway_note.md")).exists()).toBe(false);
    });

    // A hand-edited index or a half-written save leaves one without the other.
    test("F3 cleans up an orphan on either side", async () => {
        await writeFile(join(memoryDir(), "MEMORY.md"), "- [Gone](gone.md) — dangling\n");
        const orphanIndex = await ForgetMemoryTool.execute({ title: "Gone" }, ctx);
        expect(orphanIndex.ok === true && orphanIndex.value.indexEntriesRemoved).toBe(1);

        await Bun.write(join(memoryDir(), "unindexed.md"), "body\n");
        const orphanFile = await ForgetMemoryTool.execute({ title: "unindexed" }, ctx);
        expect(orphanFile.ok).toBe(true);
        expect(await Bun.file(join(memoryDir(), "unindexed.md")).exists()).toBe(false);
    });

    test("F4 names the file it looked for when nothing matches", async () => {
        await seed("kept.md", "- [Kept](kept.md) — stays\n");
        const r = await ForgetMemoryTool.execute({ title: "Never Saved" }, ctx);
        expect(r.ok === false && r.error).toContain("never_saved.md");
        expect(await readFile(join(memoryDir(), "MEMORY.md"), "utf8")).toBe(
            "- [Kept](kept.md) — stays\n",
        );
    });
});

describe("removeMemoryEntry", () => {
    test("F5 leaves prose and non-matching entries alone", () => {
        const index =
            "# Memories\n\n- [A](a.md) — first\n- [B](b.md) — second\nnot an entry\n- [A again](a.md) — dupe\n";
        const { text, removed } = removeMemoryEntry(index, "a.md");
        expect(removed).toBe(2);
        expect(text).toBe("# Memories\n\n- [B](b.md) — second\nnot an entry\n");
    });
});
