import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/index.ts";
import type { Provider } from "../providers/index.ts";
import { BashTool } from "../tools/bash/index.ts";
import { EditTool } from "../tools/edit/index.ts";
import { GrepTool } from "../tools/grep/index.ts";
import { ReadTool } from "../tools/read/index.ts";
import type { ToolContext } from "../tools/types.ts";
import { renderToolResult } from "./turn.ts";

// These tests pin the bug fix at the boundary the model actually sees: what
// renderToolResult emits as the `tool` message content. Each tool returns a
// string, so the result must flow through unchanged — no JSON encoding of
// backslashes, quotes, backticks, or newlines.

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
    sessionId: "render-test-session",
    projectId: "render-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    log: () => {},
    ...overrides,
});

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-render-test-"));
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("renderToolResult — encoding preservation through the pipeline boundary", () => {
    test("RT1 ok+string passes through verbatim (no JSON encoding)", () => {
        const sample = 'line1\nline2 with `backtick` and "quote" and \\\\';
        const out = renderToolResult({ ok: true, value: sample });
        expect(out).toBe(sample);
    });

    test("RT2 error path produces 'Error: ...' prefix", () => {
        const out = renderToolResult({ ok: false, error: "boom" });
        expect(out).toBe("Error: boom");
    });

    test("RT3 fallback JSON.stringify still applies for non-string objects", () => {
        // This is the legacy path that caused the bug for Read/Bash/Grep/Edit;
        // it remains as a safe fallback for tools whose value has no free-form
        // text (e.g. Glob's `{ paths, truncated }`).
        const out = renderToolResult({ ok: true, value: { a: 1, b: ["x"] } });
        expect(out).toBe('{"a":1,"b":["x"]}');
    });

    test("RT4 Read → renderToolResult: backslashes survive verbatim", async () => {
        const path = join(workDir, "code.ts");
        // File body: literally  const re = /\\/g;
        const body = "const re = /\\\\/g;\n";
        await writeFile(path, body, "utf8");
        const result = await ReadTool.execute({ path }, makeCtx());
        const rendered = renderToolResult(result);
        // Two backslashes between forward slashes — not four.
        expect(rendered).toContain("/\\\\/g");
        expect(rendered).not.toContain("/\\\\\\\\/g");
        // The original body must be a substring of the line content (after the
        // 6-space + tab line-number prefix is stripped from the relevant line).
        const lines = rendered.split("\n");
        const codeLine = lines.find((l) => l.includes("const re"));
        expect(codeLine).toBeDefined();
        expect(codeLine?.replace(/^\s*\d+\t/, "")).toBe("const re = /\\\\/g;");
    });

    test("RT5 Read → renderToolResult: real newlines stay as real newlines", async () => {
        const path = join(workDir, "n.txt");
        await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");
        const result = await ReadTool.execute({ path }, makeCtx());
        const rendered = renderToolResult(result);
        expect(rendered).not.toContain("\\n");
        const lines = rendered.split("\n");
        expect(lines.length).toBeGreaterThan(3);
    });

    test("RT6 Read → renderToolResult: backticks and quotes survive verbatim", async () => {
        const path = join(workDir, "q.ts");
        await writeFile(path, 'const x = `hello`;\nconst y = "world";\n', "utf8");
        const result = await ReadTool.execute({ path }, makeCtx());
        const rendered = renderToolResult(result);
        expect(rendered).toContain("`hello`");
        expect(rendered).toContain('"world"');
        expect(rendered).not.toContain("\\`hello\\`");
        expect(rendered).not.toContain('\\"world\\"');
    });

    test("RT7 Bash → renderToolResult: backslashes in stdout survive verbatim", async () => {
        const fixture = join(workDir, "bs.txt");
        await writeFile(fixture, "/\\\\/g\n", "utf8");
        const result = await BashTool.execute({ command: `cat ${fixture}` }, makeCtx());
        const rendered = renderToolResult(result);
        expect(rendered).toContain("/\\\\/g");
        expect(rendered).not.toContain("/\\\\\\\\/g");
    });

    test("RT8 Grep → renderToolResult: matched line preserves backslashes verbatim", async () => {
        const fixture = join(workDir, "code.ts");
        await writeFile(fixture, "const re = /\\\\/g;\n", "utf8");
        const result = await GrepTool.execute({ pattern: "const re", path: workDir }, makeCtx());
        const rendered = renderToolResult(result);
        expect(rendered).toContain("/\\\\/g");
        expect(rendered).not.toContain("/\\\\\\\\/g");
    });

    test("RT9 Edit → renderToolResult: preview around the change preserves backslashes verbatim", async () => {
        const path = join(workDir, "code.ts");
        await writeFile(path, "const re = /\\\\/g;\n", "utf8");
        const ctx = makeCtx();
        await ReadTool.execute({ path }, ctx);
        const result = await EditTool.execute(
            { path, old_string: "const re", new_string: "const RE" },
            ctx,
        );
        const rendered = renderToolResult(result);
        expect(rendered).toContain("/\\\\/g");
        expect(rendered).not.toContain("/\\\\\\\\/g");
    });

    test("RT10 documents the regression: byte-counts for the prior JSON.stringify path", async () => {
        // This test does NOT invoke the tools — it pins the contrast between
        // the old (broken) and new (fixed) behaviour. With the buggy renderer,
        // a structured value containing two literal backslashes would emit
        // FOUR backslashes; the new path keeps it at TWO.
        const fileLine = "const re = /\\\\/g;"; // exactly two backslashes

        // OLD behaviour: structured value → JSON.stringify → 4 backslashes.
        const oldRender = JSON.stringify({ content: fileLine, totalLines: 1 });
        expect(oldRender).toContain("/\\\\\\\\/g"); // four backslashes — what the model used to see.

        // NEW behaviour: tool returns a string → renderToolResult passes it through.
        const newRender = renderToolResult({ ok: true, value: `<file>\n${fileLine}` });
        expect(newRender).toContain("/\\\\/g"); // two backslashes — what the file actually has.
        expect(newRender).not.toContain("/\\\\\\\\/g");
    });
});
