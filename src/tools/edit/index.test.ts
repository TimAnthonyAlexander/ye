import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config/index.ts";
import type { Provider } from "../../providers/index.ts";
import { _wipeSessionCheckpoints } from "../../storage/checkpoints.ts";
import { getTurnCheckpointDir } from "../../storage/paths.ts";
import { ReadTool } from "../read/index.ts";
import type { ToolContext } from "../types.ts";
import { EditTool } from "./index.ts";

const PROJECT_ID = "edit-test-project";
const SESSION_ID = "edit-test-session";

const stubProvider: Provider = {
    id: "stub",
    capabilities: { promptCache: false, toolUse: true, vision: false, serverSideWebSearch: false },
    async *stream() {
        // no-op — Edit never invokes the provider
    },
    async getContextSize() {
        return 100_000;
    },
};

const stubConfig: Config = {
    defaultProvider: "stub",
    providers: { stub: { baseUrl: "https://example.test", apiKeyEnv: "STUB_KEY" } },
    defaultModel: { provider: "stub", model: "stub-model" },
};

let workDir: string;

const makeCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
    cwd: workDir,
    signal: new AbortController().signal,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    log: () => {},
    ...overrides,
});

const readInto = async (ctx: ToolContext, path: string): Promise<void> => {
    const r = await ReadTool.execute({ path }, ctx);
    if (!r.ok) throw new Error(`Read failed: ${r.error}`);
};

interface ParsedEdit {
    readonly replacements: number;
    readonly line: number;
    readonly preview: string;
    readonly feedback: readonly string[] | null;
}

const parseEditValue = (value: unknown): ParsedEdit => {
    if (typeof value !== "string") throw new Error(`expected string, got ${typeof value}`);
    const m = value.match(/^<edit replacements="(\d+)" line="(\d+)">\n([\s\S]*)$/);
    if (!m) throw new Error(`unexpected edit value shape:\n${value}`);
    const replacements = Number(m[1]);
    const line = Number(m[2]);
    const rest = m[3] ?? "";
    const fbIdx = rest.indexOf("\n<feedback>\n");
    if (fbIdx === -1) {
        return { replacements, line, preview: rest, feedback: null };
    }
    const preview = rest.slice(0, fbIdx);
    const fbBody = rest.slice(fbIdx + "\n<feedback>\n".length);
    const close = fbBody.lastIndexOf("\n</feedback>");
    const inner = close === -1 ? fbBody : fbBody.slice(0, close);
    const feedback = inner
        .split("\n")
        .map((l) => (l.startsWith("- ") ? l.slice(2) : l))
        .filter((l) => l.length > 0);
    return { replacements, line, preview, feedback };
};

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-edit-test-"));
});

afterEach(async () => {
    await _wipeSessionCheckpoints(PROJECT_ID, SESSION_ID);
    await rm(workDir, { recursive: true, force: true });
});

describe("EditTool", () => {
    test("E1 rejects relative path", async () => {
        const ctx = makeCtx();
        const r = await EditTool.execute(
            { path: "rel/path.txt", old_string: "a", new_string: "b" },
            ctx,
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe("path must be absolute");
    });

    test("E2 rejects empty old_string", async () => {
        const path = join(workDir, "f.txt");
        await writeFile(path, "hello", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "", new_string: "x" }, ctx);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe("old_string must not be empty");
    });

    test("E3 rejects identical old_string and new_string", async () => {
        const path = join(workDir, "f.txt");
        await writeFile(path, "hello", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "x", new_string: "x" }, ctx);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe("old_string and new_string are identical");
    });

    test("E4 rejects when file not yet Read in this session", async () => {
        const path = join(workDir, "f.txt");
        await writeFile(path, "hello", "utf8");
        const ctx = makeCtx();
        const r = await EditTool.execute({ path, old_string: "hello", new_string: "world" }, ctx);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain("Read");
            expect(r.error).toContain("before editing it.");
        }
    });

    test("E5 rejects when file disappeared between Read and Edit", async () => {
        const path = join(workDir, "vanish.txt");
        await writeFile(path, "hello", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        await rm(path);
        const r = await EditTool.execute({ path, old_string: "hello", new_string: "world" }, ctx);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("file not found");
    });

    test("E6 rejects when file changed on disk after Read (hash mismatch)", async () => {
        const path = join(workDir, "drift.txt");
        await writeFile(path, "hello", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        await writeFile(path, "drifted", "utf8");
        const r = await EditTool.execute({ path, old_string: "drifted", new_string: "x" }, ctx);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("has been modified since you last Read it");
    });

    test("E7 rejects when old_string not found", async () => {
        const path = join(workDir, "f.txt");
        await writeFile(path, "hello world", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute(
            { path, old_string: "does-not-occur", new_string: "x" },
            ctx,
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("old_string not found");
    });

    test("E8 rejects multi-match without replace_all", async () => {
        const path = join(workDir, "multi.txt");
        await writeFile(path, "foo\nfoo\nfoo\n", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "foo", new_string: "bar" }, ctx);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain("matches 3 occurrences");
            expect(r.error).toContain("replace_all: true");
        }
    });

    test("E9 single-match replace updates content and refreshes hash", async () => {
        const path = join(workDir, "simple.txt");
        await writeFile(path, "alpha beta gamma", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const beforeHash = ctx.turnState.readFiles.get(path)?.hash;
        const r = await EditTool.execute({ path, old_string: "beta", new_string: "BETA" }, ctx);
        expect(r.ok).toBe(true);
        const updated = await readFile(path, "utf8");
        expect(updated).toBe("alpha BETA gamma");
        const afterHash = ctx.turnState.readFiles.get(path)?.hash;
        expect(afterHash).toBeDefined();
        expect(afterHash).not.toBe(beforeHash);
    });

    test("E10 replace_all replaces every occurrence and is idempotent on re-run", async () => {
        const path = join(workDir, "multi.txt");
        await writeFile(path, "foo foo foo", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const first = await EditTool.execute(
            { path, old_string: "foo", new_string: "bar", replace_all: true },
            ctx,
        );
        expect(first.ok).toBe(true);
        if (first.ok) {
            expect(parseEditValue(first.value).replacements).toBe(3);
        }
        expect(await readFile(path, "utf8")).toBe("bar bar bar");

        const second = await EditTool.execute(
            { path, old_string: "foo", new_string: "bar", replace_all: true },
            ctx,
        );
        expect(second.ok).toBe(false);
        if (!second.ok) expect(second.error).toContain("old_string not found");
    });

    test("E11 calls checkpointFile before mutation (snapshot exists with original content)", async () => {
        const path = join(workDir, "cp.txt");
        await writeFile(path, "original-content", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute(
            { path, old_string: "original", new_string: "edited" },
            ctx,
        );
        expect(r.ok).toBe(true);

        const turnDir = getTurnCheckpointDir(PROJECT_ID, SESSION_ID, 0);
        const manifestRaw = await readFile(join(turnDir, "manifest.json"), "utf8");
        const manifest = JSON.parse(manifestRaw) as {
            entries: { path: string; snapshotName: string | null }[];
        };
        expect(manifest.entries.length).toBe(1);
        expect(manifest.entries[0]?.path).toBe(path);
        const snapshotName = manifest.entries[0]?.snapshotName;
        expect(snapshotName).not.toBeNull();
        const snap = await readFile(join(turnDir, snapshotName!), "utf8");
        expect(snap).toBe("original-content");
    });

    test("E12 preserves trailing newline", async () => {
        const path = join(workDir, "trailing.txt");
        await writeFile(path, "alpha\nbeta\n", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(r.ok).toBe(true);
        const updated = await readFile(path, "utf8");
        expect(updated).toBe("ALPHA\nbeta\n");
        expect(updated.endsWith("\n")).toBe(true);
    });

    test("E13a forwards heuristic feedback onto EditValue when warnings fire", async () => {
        const path = join(workDir, "stub.txt");
        await writeFile(path, "function existing() { return 1; }\n", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute(
            {
                path,
                old_string: "function existing() { return 1; }",
                new_string: "function existing() {\n  // ...existing code...\n  return 1;\n}",
            },
            ctx,
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            const parsed = parseEditValue(r.value);
            expect(parsed.feedback).not.toBeNull();
            expect(parsed.feedback?.some((m) => m.startsWith("stub:"))).toBe(true);
        }
    });

    test("E13b omits feedback section entirely when no warnings fire", async () => {
        const path = join(workDir, "clean.txt");
        await writeFile(path, "alpha beta gamma\n", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "beta", new_string: "BETA" }, ctx);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(parseEditValue(r.value).feedback).toBeNull();
            expect(typeof r.value === "string" && r.value.includes("<feedback>")).toBe(false);
        }
    });

    test("E15 returns a string value (not an object)", async () => {
        const path = join(workDir, "v.txt");
        await writeFile(path, "alpha", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(r.ok).toBe(true);
        if (r.ok) expect(typeof r.value).toBe("string");
    });

    test("E16 preview preserves backslashes byte-for-byte (no JSON escaping)", async () => {
        // File contains: const re = /\\/g;  — two literal backslashes.
        const path = join(workDir, "regex.ts");
        await writeFile(path, "const re = /\\\\/g;\n", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute(
            { path, old_string: "const re", new_string: "const RE" },
            ctx,
        );
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            // The preview must show the surrounding regex with TWO backslashes,
            // not four. The JSON.stringify regression would produce four.
            expect(r.value).toContain("/\\\\/g");
            expect(r.value).not.toContain("/\\\\\\\\/g");
        }
    });

    test("E17 preview preserves backticks and quotes byte-for-byte", async () => {
        const path = join(workDir, "tpl.ts");
        await writeFile(path, 'const x = `hello`;\nconst y = "world";\n', "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute(
            { path, old_string: "const x", new_string: "const X" },
            ctx,
        );
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain("`hello`");
            expect(r.value).toContain('"world"');
            expect(r.value).not.toContain("\\`hello\\`");
            expect(r.value).not.toContain('\\"world\\"');
        }
    });

    test("E18 preview body uses real newlines (not escape sequences)", async () => {
        const path = join(workDir, "ml.txt");
        await writeFile(path, "row-1\nrow-2\nrow-3\nrow-4\nrow-5\n", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "row-3", new_string: "ROW-3" }, ctx);
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).not.toContain("\\n");
            // Multi-line preview must split on real newlines.
            const previewLines = r.value.split("\n").slice(1);
            expect(previewLines.length).toBeGreaterThan(1);
        }
    });

    test("E19 mismatch error keeps the JSON-escaped windows (regression check on intentional escaping)", async () => {
        // The Edit tool intentionally JSON-escapes the small mismatch windows
        // for byte-by-byte comparison. That path is unrelated to the result-
        // shape change and must keep working.
        const path = join(workDir, "code.ts");
        const fileBody = "the quick brown fox jumps over the lazy dog and a dog barks";
        await writeFile(path, fileBody, "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute(
            {
                path,
                old_string: "the quick brown fox jumps over the lazy DOGGO and a dog barks",
                new_string: "x",
            },
            ctx,
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain("yours:");
            expect(r.error).toContain("file:");
        }
    });

    test("E14 subagent isolation: parent's Read does not satisfy child's Edit", async () => {
        const path = join(workDir, "shared.txt");
        await writeFile(path, "shared content", "utf8");
        const parentCtx = makeCtx();
        await readInto(parentCtx, path);
        // Child gets a fresh, empty TurnState — parent's readFiles is not shared.
        const childCtx = makeCtx();
        const r = await EditTool.execute({ path, old_string: "shared", new_string: "X" }, childCtx);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain("Read");
            expect(r.error).toContain("before editing it.");
        }
        // File on disk is untouched.
        expect(await readFile(path, "utf8")).toBe("shared content");
        // Sanity: parent could have edited it.
        expect(existsSync(path)).toBe(true);
    });
});
