import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/index.ts";
import type { Provider } from "../providers/index.ts";
import { _wipeSessionCheckpoints } from "../storage/checkpoints.ts";
import { EditTool } from "./edit/index.ts";
import { _resetFormatTimeoutMs, _setFormatTimeoutMs } from "./format.ts";
import { ReadTool } from "./read/index.ts";
import type { ToolContext } from "./types.ts";
import { WriteTool } from "./write/index.ts";

type FormatConfig = NonNullable<Config["format"]>;

const PROJECT_ID = "format-test-project";
const SESSION_ID = "format-test-session";

const stubProvider: Provider = {
    id: "stub",
    capabilities: { promptCache: false, toolUse: true, vision: false, serverSideWebSearch: false },
    async *stream() {
        // no-op — neither Edit nor Write invokes the provider
    },
    async getContextSize() {
        return 100_000;
    },
};

const baseConfig: Config = {
    defaultProvider: "stub",
    providers: { stub: { baseUrl: "https://example.test", apiKeyEnv: "STUB_KEY" } },
    defaultModel: { provider: "stub", model: "stub-model" },
};

let workDir: string;

const makeCtx = (format?: FormatConfig): ToolContext => ({
    cwd: workDir,
    signal: new AbortController().signal,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: format === undefined ? baseConfig : { ...baseConfig, format },
    activeModel: "stub-model",
    headless: false,
    log: () => {},
});

const readInto = async (ctx: ToolContext, path: string): Promise<void> => {
    const r = await ReadTool.execute({ path }, ctx);
    if (!r.ok) throw new Error(`Read failed: ${r.error}`);
};

const writeScript = async (name: string, body: string): Promise<string> => {
    const path = join(workDir, name);
    await writeFile(path, body, "utf8");
    await chmod(path, 0o755);
    return path;
};

const APPEND_SCRIPT = "#!/bin/sh\nprintf 'FMT\\n' >> \"$1\"\n";
const PREPEND_SCRIPT =
    '#!/bin/sh\nprintf \'HEADER\\n\' > "$1.ye-fmt"\ncat "$1" >> "$1.ye-fmt"\nmv "$1.ye-fmt" "$1"\n';

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-format-test-"));
});

afterEach(async () => {
    _resetFormatTimeoutMs();
    await _wipeSessionCheckpoints(PROJECT_ID, SESSION_ID);
    await rm(workDir, { recursive: true, force: true });
});

describe("post-write formatting", () => {
    test("F1 runs the matching formatter after a successful Edit", async () => {
        const path = join(workDir, "a.txt");
        await writeFile(path, "alpha\n", "utf8");
        const ctx = makeCtx({
            enabled: true,
            formatters: { "*.txt": "printf 'FMT\\n' >> $FILE" },
        });
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(r.ok).toBe(true);
        expect(await readFile(path, "utf8")).toBe("ALPHA\nFMT\n");
    });

    test("F2 absent format config changes nothing", async () => {
        const path = join(workDir, "a.txt");
        await writeFile(path, "alpha\n", "utf8");
        const ctx = makeCtx();
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(r.ok).toBe(true);
        expect(await readFile(path, "utf8")).toBe("ALPHA\n");
        if (r.ok && typeof r.value === "string") {
            expect(r.value).not.toContain("formatter");
        }
    });

    test("F3 enabled: false does not run the formatter", async () => {
        const path = join(workDir, "a.txt");
        await writeFile(path, "alpha\n", "utf8");
        const ctx = makeCtx({
            enabled: false,
            formatters: { "*.txt": "printf 'FMT\\n' >> $FILE" },
        });
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(r.ok).toBe(true);
        expect(await readFile(path, "utf8")).toBe("ALPHA\n");
    });

    test("F4 non-matching glob is skipped", async () => {
        const path = join(workDir, "a.txt");
        await writeFile(path, "alpha\n", "utf8");
        const ctx = makeCtx({
            enabled: true,
            formatters: { "*.md": "printf 'FMT\\n' >> $FILE" },
        });
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(r.ok).toBe(true);
        expect(await readFile(path, "utf8")).toBe("ALPHA\n");
    });

    test("F5 a template without $FILE gets the path appended", async () => {
        const script = await writeScript("fmt.sh", APPEND_SCRIPT);
        const path = join(workDir, "a.txt");
        await writeFile(path, "alpha\n", "utf8");
        const ctx = makeCtx({ enabled: true, formatters: { "*.txt": `sh '${script}'` } });
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(r.ok).toBe(true);
        expect(await readFile(path, "utf8")).toBe("ALPHA\nFMT\n");
    });

    test("F6 $FILE is substituted and shell-quoted (path with a space)", async () => {
        const script = await writeScript("fmt.sh", APPEND_SCRIPT);
        const path = join(workDir, "with space.txt");
        await writeFile(path, "alpha\n", "utf8");
        const ctx = makeCtx({ enabled: true, formatters: { "*.txt": `sh '${script}' $FILE` } });
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(r.ok).toBe(true);
        expect(await readFile(path, "utf8")).toBe("ALPHA\nFMT\n");
    });

    test("F7 only the first matching entry runs (no chaining)", async () => {
        const path = join(workDir, "a.txt");
        await writeFile(path, "alpha\n", "utf8");
        const ctx = makeCtx({
            enabled: true,
            formatters: {
                "*.txt": "printf 'FIRST\\n' >> $FILE",
                "a*": "printf 'SECOND\\n' >> $FILE",
            },
        });
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(r.ok).toBe(true);
        const after = await readFile(path, "utf8");
        expect(after).toBe("ALPHA\nFIRST\n");
        expect(after).not.toContain("SECOND");
    });

    test("F8 a failing formatter still leaves the Edit successful", async () => {
        const path = join(workDir, "a.txt");
        await writeFile(path, "alpha\n", "utf8");
        const ctx = makeCtx({
            enabled: true,
            formatters: { "*.txt": ": $FILE; echo boom >&2; exit 3" },
        });
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(r.ok).toBe(true);
        expect(await readFile(path, "utf8")).toBe("ALPHA\n");
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain("formatter exited 3");
            expect(r.value).toContain("boom");
        }
    });

    test("F9 a long stderr is truncated in the note", async () => {
        const path = join(workDir, "a.txt");
        await writeFile(path, "alpha\n", "utf8");
        const ctx = makeCtx({
            enabled: true,
            formatters: { "*.txt": ": $FILE; yes ERRORLINE | head -c 5000 >&2; exit 1" },
        });
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain("formatter exited 1");
            expect(r.value.length).toBeLessThan(1500);
        }
    });

    test("F10 a hanging formatter is killed and the Edit still succeeds", async () => {
        _setFormatTimeoutMs(200);
        const path = join(workDir, "a.txt");
        await writeFile(path, "alpha\n", "utf8");
        const ctx = makeCtx({ enabled: true, formatters: { "*.txt": ": $FILE; sleep 30" } });
        await readInto(ctx, path);
        const startedAt = performance.now();
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        const elapsed = performance.now() - startedAt;
        expect(r.ok).toBe(true);
        expect(elapsed).toBeLessThan(4000);
        expect(await readFile(path, "utf8")).toBe("ALPHA\n");
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain("timed out");
        }
    });

    test("F11 a second Edit succeeds after the formatter rewrote the file", async () => {
        const path = join(workDir, "a.txt");
        await writeFile(path, "alpha\nbeta\n", "utf8");
        const ctx = makeCtx({
            enabled: true,
            formatters: { "*.txt": "printf 'FMT\\n' >> $FILE" },
        });
        await readInto(ctx, path);

        const first = await EditTool.execute(
            { path, old_string: "alpha", new_string: "ALPHA" },
            ctx,
        );
        expect(first.ok).toBe(true);

        const second = await EditTool.execute(
            { path, old_string: "beta", new_string: "BETA" },
            ctx,
        );
        expect(second.ok).toBe(true);
        expect(await readFile(path, "utf8")).toBe("ALPHA\nBETA\nFMT\nFMT\n");
    });

    test("F12 preview reflects post-format line numbers", async () => {
        const script = await writeScript("prepend.sh", PREPEND_SCRIPT);
        const path = join(workDir, "a.txt");
        await writeFile(path, "alpha\nbeta\n", "utf8");
        const ctx = makeCtx({ enabled: true, formatters: { "*.txt": `sh '${script}' $FILE` } });
        await readInto(ctx, path);
        const r = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(r.ok).toBe(true);
        if (r.ok && typeof r.value === "string") {
            expect(r.value).toContain('line="2"');
            expect(r.value).toContain("HEADER");
        }
    });

    test("F13 Write runs the formatter and keeps the next Edit valid", async () => {
        const path = join(workDir, "new.txt");
        const ctx = makeCtx({
            enabled: true,
            formatters: { "*.txt": "printf 'FMT\\n' >> $FILE" },
        });
        const w = await WriteTool.execute({ path, content: "alpha\n" }, ctx);
        expect(w.ok).toBe(true);
        expect(await readFile(path, "utf8")).toBe("alpha\nFMT\n");

        const e = await EditTool.execute({ path, old_string: "alpha", new_string: "ALPHA" }, ctx);
        expect(e.ok).toBe(true);
        expect(await readFile(path, "utf8")).toBe("ALPHA\nFMT\nFMT\n");
    });

    test("F14 a failing formatter still leaves the Write successful, with a note", async () => {
        const path = join(workDir, "new.txt");
        const ctx = makeCtx({
            enabled: true,
            formatters: { "*.txt": ": $FILE; echo boom >&2; exit 7" },
        });
        const w = await WriteTool.execute({ path, content: "alpha\n" }, ctx);
        expect(w.ok).toBe(true);
        expect(await readFile(path, "utf8")).toBe("alpha\n");
        if (w.ok) {
            const value = w.value as { bytes: number; note?: string };
            expect(value.bytes).toBe(6);
            expect(value.note).toContain("formatter exited 7");
        }
    });

    test("F15 Write without format config returns no note", async () => {
        const path = join(workDir, "new.txt");
        const ctx = makeCtx();
        const w = await WriteTool.execute({ path, content: "alpha\n" }, ctx);
        expect(w.ok).toBe(true);
        if (w.ok) {
            expect(w.value as { bytes: number; note?: string }).toEqual({ bytes: 6 });
        }
    });
});
