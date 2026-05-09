import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config/index.ts";
import type { Provider } from "../../providers/index.ts";
import type { ToolContext } from "../types.ts";
import { ReadTool } from "./index.ts";

const stubProvider: Provider = {
    id: "stub",
    capabilities: { promptCache: false, toolUse: true, vision: false, serverSideWebSearch: false },
    async *stream() {
        // no-op
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
    sessionId: "read-test-session",
    projectId: "read-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    log: () => {},
    ...overrides,
});

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-read-test-"));
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("ReadTool", () => {
    test("R1 returns a string value (not an object)", async () => {
        const path = join(workDir, "f.txt");
        await writeFile(path, "hello\nworld\n", "utf8");
        const r = await ReadTool.execute({ path }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(typeof r.value).toBe("string");
        }
    });

    test("R2 rejects relative path", async () => {
        const r = await ReadTool.execute({ path: "rel.txt" }, makeCtx());
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe("path must be absolute");
    });

    test("R3 reports missing file", async () => {
        const r = await ReadTool.execute({ path: join(workDir, "nope.txt") }, makeCtx());
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("file not found");
    });

    test("R4 header includes path, total lines, and range", async () => {
        const path = join(workDir, "h.txt");
        await writeFile(path, "a\nb\nc\n", "utf8");
        const r = await ReadTool.execute({ path }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            const firstLine = r.value.split("\n")[0];
            expect(firstLine).toBe(`<read path="${path}" lines="4" range="1-4">`);
        }
    });

    test("R5 numbered content uses real newlines (not escape sequences)", async () => {
        const path = join(workDir, "n.txt");
        await writeFile(path, "alpha\nbeta\ngamma", "utf8");
        const r = await ReadTool.execute({ path }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).not.toContain("\\n");
            const lines = r.value.split("\n");
            expect(lines[1]).toBe("     1\talpha");
            expect(lines[2]).toBe("     2\tbeta");
            expect(lines[3]).toBe("     3\tgamma");
        }
    });

    test("R6 preserves single backslashes byte-for-byte", async () => {
        const path = join(workDir, "bs1.txt");
        // File contains exactly: \Device  (one literal backslash)
        await writeFile(path, "\\Device", "utf8");
        const r = await ReadTool.execute({ path }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            // Must contain exactly one backslash before "Device".
            expect(r.value).toContain("\\Device");
            expect(r.value).not.toContain("\\\\Device");
        }
    });

    test("R7 preserves double backslashes byte-for-byte (the regression case)", async () => {
        const path = join(workDir, "bs2.txt");
        // Source represents: const re = /\\/g; — two literal backslashes between slashes.
        const fileBody = "const re = /\\\\/g;\n";
        await writeFile(path, fileBody, "utf8");
        const r = await ReadTool.execute({ path }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            // Exactly two backslashes — not four (the JSON.stringify regression).
            expect(r.value).toContain("/\\\\/g");
            expect(r.value).not.toContain("/\\\\\\\\/g");
        }
    });

    test("R8 preserves backticks byte-for-byte", async () => {
        const path = join(workDir, "tick.txt");
        const fileBody = "const x = `hello`;\n";
        await writeFile(path, fileBody, "utf8");
        const r = await ReadTool.execute({ path }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain("`hello`");
        }
    });

    test("R9 preserves double quotes byte-for-byte (no JSON escaping)", async () => {
        const path = join(workDir, "q.txt");
        await writeFile(path, 'say "hi"\n', "utf8");
        const r = await ReadTool.execute({ path }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain('say "hi"');
            expect(r.value).not.toContain('say \\"hi\\"');
        }
    });

    test("R10 round-trip: file body re-extractable from result without unescape", async () => {
        const path = join(workDir, "rt.txt");
        // A line with mixed escape-prone characters — backslash, backtick, quote, tab.
        const body = `line1: \\\`hi\` "ok"\n\tline2 with tab\n`;
        await writeFile(path, body, "utf8");
        const r = await ReadTool.execute({ path }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            // Strip the header line and the line-number prefixes; what's left
            // joined by "\n" must equal the original body (minus the implicit
            // trailing empty line from .split("\n")).
            const lines = r.value.split("\n").slice(1);
            const stripped = lines.map((l) => l.replace(/^\s*\d+\t/, "")).join("\n");
            expect(stripped).toBe(body);
        }
    });

    test("R11 offset+limit produces correct shown range", async () => {
        const path = join(workDir, "big.txt");
        const body = Array.from({ length: 20 }, (_, i) => `row-${i + 1}`).join("\n") + "\n";
        await writeFile(path, body, "utf8");
        const r = await ReadTool.execute({ path, offset: 5, limit: 3 }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            const firstLine = r.value.split("\n")[0];
            expect(firstLine).toBe(`<read path="${path}" lines="21" range="6-8">`);
            expect(r.value).toContain("     6\trow-6");
            expect(r.value).toContain("     7\trow-7");
            expect(r.value).toContain("     8\trow-8");
            expect(r.value).not.toContain("row-5");
            expect(r.value).not.toContain("row-9");
        }
    });

    test("R12 records hash so subsequent Edit succeeds", async () => {
        const path = join(workDir, "h.txt");
        await writeFile(path, "hello", "utf8");
        const ctx = makeCtx();
        await ReadTool.execute({ path }, ctx);
        expect(ctx.turnState.readFiles.has(path)).toBe(true);
        expect(ctx.turnState.readFiles.get(path)?.hash.length ?? 0).toBeGreaterThan(0);
    });

    test("R13 empty file produces a header with range 1-1 and a single numbered empty line", async () => {
        const path = join(workDir, "empty.txt");
        await writeFile(path, "", "utf8");
        const r = await ReadTool.execute({ path }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            const lines = r.value.split("\n");
            expect(lines[0]).toBe(`<read path="${path}" lines="1" range="1-1">`);
            expect(lines[1]).toBe("     1\t");
        }
    });
});
