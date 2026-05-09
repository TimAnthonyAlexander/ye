import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config/index.ts";
import type { Provider } from "../../providers/index.ts";
import type { ToolContext } from "../types.ts";
import { GrepTool } from "./index.ts";

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
    sessionId: "grep-test-session",
    projectId: "grep-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    log: () => {},
    ...overrides,
});

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-grep-test-"));
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("GrepTool", () => {
    test("G1 returns a string value (not an object)", async () => {
        const fixture = join(workDir, "f.txt");
        await writeFile(fixture, "needle\n", "utf8");
        const r = await GrepTool.execute({ pattern: "needle", path: workDir }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok) expect(typeof r.value).toBe("string");
    });

    test("G2 success with matches: header is exit_code 0 and body has the match line", async () => {
        const fixture = join(workDir, "f.txt");
        await writeFile(fixture, "alpha\nneedle\ngamma\n", "utf8");
        const r = await GrepTool.execute({ pattern: "needle", path: workDir }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value.split("\n")[0]).toBe('<grep exit_code="0">');
            expect(r.value).toContain("needle");
        }
    });

    test("G3 no matches: exit_code 1 with no body content", async () => {
        const fixture = join(workDir, "f.txt");
        await writeFile(fixture, "alpha\nbeta\n", "utf8");
        const r = await GrepTool.execute({ pattern: "absent", path: workDir }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toBe('<grep exit_code="1">');
        }
    });

    test("G4 preserves backslashes byte-for-byte (the regression case)", async () => {
        // File contains: const re = /\\/g;
        const fixture = join(workDir, "code.ts");
        await writeFile(fixture, "const re = /\\\\/g;\n", "utf8");
        const r = await GrepTool.execute({ pattern: "const re", path: workDir }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain("/\\\\/g");
            expect(r.value).not.toContain("/\\\\\\\\/g");
        }
    });

    test("G5 preserves real newlines (not escape sequences)", async () => {
        const fixture = join(workDir, "multi.txt");
        await writeFile(fixture, "hit-1\nmiss\nhit-2\nhit-3\n", "utf8");
        const r = await GrepTool.execute({ pattern: "hit", path: workDir }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).not.toContain("\\n");
            const lines = r.value.split("\n");
            expect(lines.length).toBeGreaterThanOrEqual(4); // header + 3 hit lines
        }
    });

    test("G6 preserves backticks byte-for-byte", async () => {
        const fixture = join(workDir, "tick.txt");
        await writeFile(fixture, "wrap `hi` here\n", "utf8");
        const r = await GrepTool.execute({ pattern: "wrap", path: workDir }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain("`hi`");
        }
    });
});
