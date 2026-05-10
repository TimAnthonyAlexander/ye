import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config/index.ts";
import type { Provider } from "../../providers/index.ts";
import type { ToolContext } from "../types.ts";
import { BashTool } from "./index.ts";

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
    sessionId: "bash-test-session",
    projectId: "bash-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    log: () => {},
    ...overrides,
});

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-bash-test-"));
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("BashTool", () => {
    test("B1 returns a string value (not an object)", async () => {
        const r = await BashTool.execute({ command: "echo hi" }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok) expect(typeof r.value).toBe("string");
    });

    test("B2 success header includes exit code 0 and shows stdout", async () => {
        const r = await BashTool.execute({ command: "echo hello" }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value.split("\n")[0]).toMatch(/^<bash exit_code="0" duration_ms="\d+">$/);
            expect(r.value).toContain("hello");
        }
    });

    test("B3 non-zero exit code reflected in header", async () => {
        const r = await BashTool.execute({ command: "exit 7" }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toMatch(/<bash exit_code="7" duration_ms="\d+">/);
        }
    });

    test("B4 stderr is wrapped in <stderr> when present", async () => {
        const r = await BashTool.execute({ command: "printf out; printf 'oh no' >&2" }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toMatch(/<bash exit_code="0" duration_ms="\d+">/);
            expect(r.value).toContain("out");
            expect(r.value).toContain("<stderr>\noh no\n</stderr>");
        }
    });

    test("B5 omits stderr section when stderr is empty", async () => {
        const r = await BashTool.execute({ command: "echo silent" }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).not.toContain("<stderr>");
        }
    });

    test("B6 preserves backslashes byte-for-byte (no JSON escaping)", async () => {
        // File body: literally /\\/g — two backslashes between forward slashes.
        const fixture = join(workDir, "bs.txt");
        await writeFile(fixture, "/\\\\/g\n", "utf8");
        const r = await BashTool.execute({ command: `cat ${fixture}` }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain("/\\\\/g");
            expect(r.value).not.toContain("/\\\\\\\\/g");
        }
    });

    test("B7 preserves real newlines (not escape sequences)", async () => {
        const fixture = join(workDir, "nl.txt");
        await writeFile(fixture, "a\nb\nc\n", "utf8");
        const r = await BashTool.execute({ command: `cat ${fixture}` }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).not.toContain("\\n");
            const body = r.value.split("\n").slice(1);
            expect(body[0]).toBe("a");
            expect(body[1]).toBe("b");
            expect(body[2]).toBe("c");
        }
    });

    test("B8 preserves backticks byte-for-byte", async () => {
        const fixture = join(workDir, "tick.txt");
        await writeFile(fixture, "`hi`\n", "utf8");
        const r = await BashTool.execute({ command: `cat ${fixture}` }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain("`hi`");
        }
    });

    test("B9 duration_ms reflects actual elapsed time", async () => {
        const r = await BashTool.execute({ command: "sleep 0.1" }, makeCtx());
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            const match = r.value.match(/duration_ms="(\d+)"/);
            expect(match).not.toBeNull();
            const ms = Number(match?.[1] ?? 0);
            expect(ms).toBeGreaterThanOrEqual(100);
            expect(ms).toBeLessThan(2000);
        }
    });
});
