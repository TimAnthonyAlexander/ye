import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, LspServerConfig } from "../../config/types.ts";
import { lspToolsAvailable } from "../../lsp/availability.ts";
import { disposeClients } from "../../lsp/manager.ts";
import type { Provider } from "../../providers/index.ts";
import { assembleToolPool } from "../pool.ts";
// listTools, not getTool: another suite mock.modules the tools barrel
// process-globally, which clobbers getTool for every importer.
import { listTools } from "../registry.ts";
import type { ToolContext } from "../types.ts";
import { DefinitionTool } from "./definition.ts";
import { ReferencesTool } from "./references.ts";
import { SymbolSearchTool } from "./symbolSearch.ts";

const FIXTURE = join(import.meta.dir, "..", "..", "lsp", "fixtures", "fakeServer.ts");

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

const fakeServer = (mode: string): LspServerConfig => ({
    command: process.execPath,
    args: [FIXTURE, mode],
});

let workDir: string;
let samplePath: string;

const configWith = (lsp?: Config["lsp"]): Config => ({
    defaultProvider: "stub",
    providers: { stub: { baseUrl: "https://example.test", apiKeyEnv: "STUB_KEY" } },
    defaultModel: { provider: "stub", model: "stub-model" },
    ...(lsp ? { lsp } : {}),
});

const makeCtx = (lsp?: Config["lsp"]): ToolContext => ({
    cwd: workDir,
    signal: new AbortController().signal,
    sessionId: "lsp-test-session",
    projectId: "lsp-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: configWith(lsp),
    activeModel: "stub-model",
    log: () => {},
});

const text = (value: unknown): string => String(value);

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-lsptools-test-"));
    samplePath = join(workDir, "sample.ts");
    await writeFile(samplePath, "export const value = 1;\n".repeat(10), "utf8");
});

afterEach(async () => {
    await disposeClients();
    await rm(workDir, { recursive: true, force: true });
});

describe("LSP navigation tools", () => {
    test("N1 all three are read-only, resolvable by name, and pooled only when configured", () => {
        const listed = listTools().map((t) => t.name);
        const pooled = assembleToolPool({ mode: "NORMAL", rules: [] }).map((t) => t.name);
        for (const tool of [DefinitionTool, ReferencesTool, SymbolSearchTool]) {
            expect(tool.annotations.readOnlyHint).toBe(true);
            expect(listed.includes(tool.name)).toBe(lspToolsAvailable());
            expect(pooled.includes(tool.name)).toBe(lspToolsAvailable());
        }
    });

    test("N2 lsp disabled returns an actionable message naming the config key", async () => {
        const r = await DefinitionTool.execute(
            { path: samplePath, line: 1, column: 1 },
            makeCtx(undefined),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain("lsp.enabled");
            expect(r.error).toContain("config.json");
            expect(r.error).toContain("Grep");
            expect(r.error).toContain("not a failure of your work");
        }
    });

    test("N3 an unconfigured language names the key to add", async () => {
        const py = join(workDir, "sample.py");
        await writeFile(py, "value = 1\n", "utf8");
        const r = await DefinitionTool.execute(
            { path: py, line: 1, column: 1 },
            makeCtx({ enabled: true, servers: { typescript: fakeServer("normal") } }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain("lsp.servers.python");
            expect(r.error).toContain("Grep");
        }
    });

    test("N4 an unmapped extension says so instead of failing obscurely", async () => {
        const odd = join(workDir, "notes.zzz");
        await writeFile(odd, "hello\n", "utf8");
        const r = await DefinitionTool.execute(
            { path: odd, line: 1, column: 1 },
            makeCtx({ enabled: true, servers: { typescript: fakeServer("normal") } }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain(".zzz");
            expect(r.error).toContain("Grep");
        }
    });

    test("N5 Definition converts 1-based input and 0-based output", async () => {
        const r = await DefinitionTool.execute(
            { path: samplePath, line: 5, column: 3 },
            makeCtx({ enabled: true, servers: { typescript: fakeServer("normal") } }),
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            // The fake server echoes the 0-based position it received; getting
            // 5:3 back proves both conversions.
            expect(text(r.value)).toContain("sample.ts:5:3");
            expect(text(r.value)).toContain("other.ts:1:1");
            expect(text(r.value)).toContain('<definition path="sample.ts" line="5" column="3"');
            expect(text(r.value)).toContain('count="2"');
        }
    });

    test("N6 References honours includeDeclaration and sorts its hits", async () => {
        const lsp = { enabled: true, servers: { typescript: fakeServer("normal") } };
        const withDeclaration = await ReferencesTool.execute(
            { path: samplePath, line: 1, column: 1, includeDeclaration: true },
            makeCtx(lsp),
        );
        const withoutDeclaration = await ReferencesTool.execute(
            { path: samplePath, line: 1, column: 1, includeDeclaration: false },
            makeCtx(lsp),
        );

        expect(withDeclaration.ok).toBe(true);
        expect(withoutDeclaration.ok).toBe(true);
        if (withDeclaration.ok && withoutDeclaration.ok) {
            const body = text(withDeclaration.value);
            expect(body).toContain('include_declaration="true" count="3"');
            expect(body).toContain("sample.ts:42:9");
            expect(body.indexOf("use-a.ts:2:1")).toBeLessThan(body.indexOf("use-b.ts:7:3"));
            expect(text(withoutDeclaration.value)).toContain('count="2"');
            expect(text(withoutDeclaration.value)).not.toContain("sample.ts:42:9");
        }
    });

    test("N7 SymbolSearch reports kind, container and 1-based location", async () => {
        const r = await SymbolSearchTool.execute(
            { query: "foo" },
            makeCtx({ enabled: true, servers: { typescript: fakeServer("normal") } }),
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(text(r.value)).toContain('<symbol_search query="foo" count="2">');
            expect(text(r.value)).toContain("Function fooHandler — /workspace/src/handler.ts:10:1");
            expect(text(r.value)).toContain(
                "Class fooStore (in state) — /workspace/src/store.ts:1:1",
            );
        }
    });

    test("N7b SymbolSearch waits out a cold project instead of reporting no matches", async () => {
        const r = await SymbolSearchTool.execute(
            { query: "foo" },
            makeCtx({ enabled: true, servers: { typescript: fakeServer("coldProject") } }),
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            // The server answers with an empty list twice before its project is
            // built. Taking that at face value would report a real symbol as
            // absent, which reads as a wrong answer rather than a failure.
            expect(text(r.value)).toContain('count="2"');
            expect(text(r.value)).toContain("Function fooHandler");
        }
    });

    test("N8 a position below 1 is rejected as a 1-based API violation", async () => {
        const lsp = { enabled: true, servers: { typescript: fakeServer("normal") } };
        const zeroLine = await DefinitionTool.execute(
            { path: samplePath, line: 0, column: 1 },
            makeCtx(lsp),
        );
        const zeroColumn = await ReferencesTool.execute(
            { path: samplePath, line: 1, column: 0 },
            makeCtx(lsp),
        );

        expect(zeroLine.ok).toBe(false);
        expect(zeroColumn.ok).toBe(false);
        if (!zeroLine.ok) expect(zeroLine.error).toContain("1-based");
        if (!zeroColumn.ok) expect(zeroColumn.error).toContain("1-based");
    });

    test("N9 a missing file is reported before any server is started", async () => {
        const r = await DefinitionTool.execute(
            { path: join(workDir, "nope.ts"), line: 1, column: 1 },
            makeCtx({ enabled: true, servers: { typescript: fakeServer("normal") } }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("file not found");
    });

    test("N10 a server that dies mid-query reports the crash, not a hang", async () => {
        const r = await DefinitionTool.execute(
            { path: samplePath, line: 1, column: 1 },
            makeCtx({ enabled: true, servers: { typescript: fakeServer("die") } }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain("typescript language server");
            expect(r.error).toContain("exited");
            expect(r.error).toContain("Grep");
        }
    });

    test("N11 a server that cannot start is reported clearly", async () => {
        const r = await SymbolSearchTool.execute(
            { query: "foo" },
            makeCtx({
                enabled: true,
                servers: { typescript: { command: join(workDir, "not-a-server") } },
            }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("could not answer");
    });

    test("N12 an empty query is rejected", async () => {
        const r = await SymbolSearchTool.execute(
            { query: "   " },
            makeCtx({ enabled: true, servers: { typescript: fakeServer("normal") } }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("query");
    });
});
