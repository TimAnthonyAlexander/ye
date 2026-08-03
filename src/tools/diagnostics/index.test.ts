import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config/index.ts";
import type { Provider } from "../../providers/index.ts";
import { listTools } from "../registry.ts";
import type { ToolContext } from "../types.ts";
import { DiagnosticsTool } from "./index.ts";

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

type VerifySettings = NonNullable<Config["verify"]>;

const configWith = (verify?: VerifySettings): Config => ({
    defaultProvider: "stub",
    providers: { stub: { baseUrl: "https://example.test", apiKeyEnv: "STUB_KEY" } },
    defaultModel: { provider: "stub", model: "stub-model" },
    ...(verify ? { verify } : {}),
});

let workDir: string;

const makeCtx = (verify?: VerifySettings, overrides: Partial<ToolContext> = {}): ToolContext => ({
    cwd: workDir,
    signal: new AbortController().signal,
    sessionId: "diagnostics-test-session",
    projectId: "diagnostics-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: configWith(verify),
    activeModel: "stub-model",
    headless: false,
    log: () => {},
    ...overrides,
});

const run = async (verify?: VerifySettings, args: unknown = {}, ctxOverrides = {}) =>
    DiagnosticsTool.execute(args, makeCtx(verify, ctxOverrides));

// The header echoes the configured command, which in these tests contains the
// very output being asserted on. Assert against the body only.
const bodyOf = (value: unknown): string => {
    const text = String(value);
    return text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n</diagnostics>"));
};

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-diagnostics-test-"));
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("DiagnosticsTool", () => {
    test("D1 registered and read-only", () => {
        // listTools, not getTool: another suite mock.modules the tools barrel
        // process-globally, which clobbers getTool for every importer.
        expect(listTools()).toContain(DiagnosticsTool);
        expect(DiagnosticsTool.annotations.readOnlyHint).toBe(true);
    });

    test("D2 unconfigured check returns an actionable message naming the config key", async () => {
        const r = await run(undefined, {});
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain("verify.typecheck");
            expect(r.error).toContain("config.json");
            expect(r.error).toContain("not a failure of your work");
        }
    });

    test("D3 unconfigured lint names the lint key specifically", async () => {
        const r = await run({ typecheck: "true" }, { check: "lint" });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("verify.lint");
    });

    test("D4 passing command reports exit 0 and no diagnostics", async () => {
        const r = await run({ typecheck: "exit 0" });
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain('<diagnostics check="typecheck" exit_code="0"');
            expect(r.value).toContain("(no diagnostics");
            expect(r.value.endsWith("</diagnostics>")).toBe(true);
        }
    });

    test("D5 failing command reports its output and exit code", async () => {
        const r = await run({ typecheck: "echo 'src/a.ts(3,9): error TS2345: bad'; exit 2" });
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain('exit_code="2"');
            expect(r.value).toContain("error TS2345: bad");
        }
    });

    test("D6 stderr output is captured too", async () => {
        const r = await run({ lint: "echo lint-problem 1>&2; exit 1" }, { check: "lint" });
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain('check="lint"');
            expect(r.value).toContain("lint-problem");
        }
    });

    test("D7 paths filters the reported lines", async () => {
        const r = await run(
            { typecheck: "printf 'src/a.ts(1,1): error A\\nsrc/b.ts(2,2): error B\\n'; exit 2" },
            { paths: ["src/a.ts"] },
        );
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(bodyOf(r.value)).toContain("src/a.ts(1,1): error A");
            expect(bodyOf(r.value)).not.toContain("error B");
            expect(r.value).toContain('paths="src/a.ts"');
        }
    });

    test("D8 absolute paths match cwd-relative output", async () => {
        const r = await run(
            { typecheck: "printf 'src/a.ts(1,1): error A\\nsrc/b.ts(2,2): error B\\n'; exit 2" },
            { paths: [join(workDir, "src/a.ts")] },
        );
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(bodyOf(r.value)).toContain("error A");
            expect(bodyOf(r.value)).not.toContain("error B");
        }
    });

    test("D9 indented continuation lines follow their file line", async () => {
        const r = await run(
            {
                lint: "printf 'src/a.ts\\n  1:1  error  no-unused\\nsrc/b.ts\\n  2:2  error  other\\n'; exit 1",
            },
            { check: "lint", paths: ["src/a.ts"] },
        );
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(bodyOf(r.value)).toContain("  1:1  error  no-unused");
            expect(bodyOf(r.value)).not.toContain("2:2");
        }
    });

    test("D10 paths matching nothing reports a filtered-out count, not silence", async () => {
        const r = await run(
            { typecheck: "printf 'src/b.ts(2,2): error B\\n'; exit 2" },
            { paths: ["src/a.ts"] },
        );
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain("no diagnostics for the requested paths");
            expect(r.value).toContain("filtered out");
        }
    });

    test("D11 truncation keeps the tail", async () => {
        const script = join(workDir, "big.sh");
        await writeFile(
            script,
            "#!/bin/sh\nawk 'BEGIN { for (i = 0; i < 4000; i++) print \"src/x.ts: error padding line number \" i }'\necho 'Found 4000 errors.'\nexit 2\n",
            "utf8",
        );
        const r = await run({ typecheck: `sh ${script}` });
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain("truncated");
            expect(r.value).toContain("Found 4000 errors.");
            expect(r.value).not.toContain("padding line number 0\n");
        }
    });

    test("D12 timeout returns a clear message and does not claim results", async () => {
        const r = await run({ typecheck: "sleep 30", timeoutMs: 300 });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain("timed out after 300ms");
            expect(r.error).toContain("verify.timeoutMs");
        }
    });

    test("D13 rejects non-string entries in paths", async () => {
        const r = await run({ typecheck: "exit 0" }, { paths: [1] });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("paths");
    });

    test("D14 rejects an unknown check", async () => {
        const r = await run({ typecheck: "exit 0" }, { check: "spellcheck" });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("check");
    });
});
