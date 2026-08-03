import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/index.ts";
import type { Provider } from "../providers/index.ts";
import { ReadTool } from "../tools/read/index.ts";
import type { ToolContext } from "../tools/types.ts";
import { collectNestedNotes, getProjectNotesFile, readNotesWithImports } from "./notesFile.ts";

let root: string;

const write = async (rel: string, body: string): Promise<string> => {
    const path = join(root, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body, "utf8");
    return path;
};

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ye-notes-test-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("getProjectNotesFile", () => {
    test("CLAUDE.md wins over YE.md and AGENTS.md", async () => {
        await write("CLAUDE.md", "claude");
        await write("YE.md", "ye");
        await write("AGENTS.md", "agents");
        const picked = getProjectNotesFile(root);
        expect(picked).toEqual({ path: join(root, "CLAUDE.md"), existed: true, format: "claude" });
    });

    test("YE.md wins over AGENTS.md", async () => {
        await write("YE.md", "ye");
        await write("AGENTS.md", "agents");
        const picked = getProjectNotesFile(root);
        expect(picked.format).toBe("ye");
        expect(picked.path).toBe(join(root, "YE.md"));
    });

    test("AGENTS.md alone is picked up", async () => {
        await write("AGENTS.md", "agents");
        const picked = getProjectNotesFile(root);
        expect(picked).toEqual({ path: join(root, "AGENTS.md"), existed: true, format: "agents" });
    });

    test("nothing present falls back to a non-existent YE.md", () => {
        const picked = getProjectNotesFile(root);
        expect(picked).toEqual({ path: join(root, "YE.md"), existed: false, format: "ye" });
    });
});

describe("readNotesWithImports", () => {
    test("missing file returns null", async () => {
        expect(await readNotesWithImports(join(root, "nope.md"))).toBeNull();
    });

    test("blank file returns null", async () => {
        const path = await write("blank.md", "   \n\n");
        expect(await readNotesWithImports(path)).toBeNull();
    });

    test("simple import is inlined", async () => {
        await write("part.md", "imported body\n");
        const path = await write("main.md", "top\n@./part.md\nbottom\n");
        expect(await readNotesWithImports(path)).toBe("top\nimported body\nbottom\n");
    });

    test("import resolves relative to the importing file's directory", async () => {
        await write("docs/shared.md", "shared\n");
        const path = await write("docs/main.md", "@shared.md\n");
        expect(await readNotesWithImports(path)).toBe("shared\n");
    });

    test("nested import (2 hops) is expanded", async () => {
        await write("c.md", "leaf\n");
        await write("b.md", "mid\n@./c.md\n");
        const path = await write("a.md", "@./b.md\n");
        expect(await readNotesWithImports(path)).toBe("mid\nleaf\n");
    });

    test("depth is capped at 4 hops — the 5th import stays literal", async () => {
        await write("f5.md", "level5\n");
        await write("f4.md", "level4\n@./f5.md\n");
        await write("f3.md", "level3\n@./f4.md\n");
        await write("f2.md", "level2\n@./f3.md\n");
        await write("f1.md", "level1\n@./f2.md\n");
        const path = await write("f0.md", "@./f1.md\n");
        const out = await readNotesWithImports(path);
        expect(out).toBe("level1\nlevel2\nlevel3\nlevel4\n@./f5.md\n");
    });

    test("a cycle terminates and leaves the re-entrant line literal", async () => {
        await write("b.md", "b-body\n@./a.md\n");
        const path = await write("a.md", "a-body\n@./b.md\n");
        expect(await readNotesWithImports(path)).toBe("a-body\nb-body\n@./a.md\n");
    });

    test("self-import is left literal", async () => {
        const path = await write("self.md", "body\n@./self.md\n");
        expect(await readNotesWithImports(path)).toBe("body\n@./self.md\n");
    });

    test("missing import target is left as a literal line", async () => {
        const path = await write("main.md", "before\n@./gone.md\nafter\n");
        expect(await readNotesWithImports(path)).toBe("before\n@./gone.md\nafter\n");
    });

    test("@ inside a fenced code block is not expanded", async () => {
        await write("part.md", "IMPORTED\n");
        const path = await write("main.md", "```\n@./part.md\n```\n");
        const out = await readNotesWithImports(path);
        expect(out).toBe("```\n@./part.md\n```\n");
        expect(out).not.toContain("IMPORTED");
    });

    test("@ inside a tilde-fenced block is not expanded", async () => {
        await write("part.md", "IMPORTED\n");
        const path = await write("main.md", "~~~\n@./part.md\n~~~\n");
        expect(await readNotesWithImports(path)).not.toContain("IMPORTED");
    });

    test("imports after a closed fence still expand", async () => {
        await write("part.md", "IMPORTED\n");
        const path = await write("main.md", "```\n@./part.md\n```\n@./part.md\n");
        expect(await readNotesWithImports(path)).toBe("```\n@./part.md\n```\nIMPORTED\n");
    });

    test("@ inside an inline code span is not expanded", async () => {
        await write("part.md", "IMPORTED\n");
        const path = await write("main.md", "`@./part.md`\n");
        expect(await readNotesWithImports(path)).toBe("`@./part.md`\n");
    });

    test("non-path @ tokens like @media and emails are left alone", async () => {
        const path = await write("main.md", "@media\nfoo@example.com\n@handle\n");
        expect(await readNotesWithImports(path)).toBe("@media\nfoo@example.com\n@handle\n");
    });

    test("absolute import paths work", async () => {
        const part = await write("abs.md", "ABS\n");
        const path = await write("main.md", `@${part}\n`);
        expect(await readNotesWithImports(path)).toBe("ABS\n");
    });
});

describe("collectNestedNotes", () => {
    test("walks up from the file's directory and orders outermost first", async () => {
        await write("CLAUDE.md", "root notes");
        await write("a/CLAUDE.md", "a notes");
        await write("a/b/AGENTS.md", "b notes");
        const found = await collectNestedNotes(join(root, "a/b/file.ts"), root);
        expect(found.map((f) => f.path)).toEqual([
            join(root, "a/CLAUDE.md"),
            join(root, "a/b/AGENTS.md"),
        ]);
        expect(found.map((f) => f.content)).toEqual(["a notes", "b notes"]);
    });

    test("excludes root-level notes files", async () => {
        await write("CLAUDE.md", "root claude");
        await write("AGENTS.md", "root agents");
        const found = await collectNestedNotes(join(root, "file.ts"), root);
        expect(found).toEqual([]);
    });

    test("never walks above the project root", async () => {
        const sub = join(root, "proj");
        await write("CLAUDE.md", "outside");
        await write("proj/file.ts", "x");
        const found = await collectNestedNotes(join(sub, "file.ts"), sub);
        expect(found).toEqual([]);
    });

    test("a file outside the project root collects nothing", async () => {
        await write("proj/CLAUDE.md", "inside");
        await write("other/file.ts", "x");
        const found = await collectNestedNotes(join(root, "other/file.ts"), join(root, "proj"));
        expect(found).toEqual([]);
    });

    test("nested notes get their imports expanded", async () => {
        await write("a/part.md", "PART\n");
        await write("a/CLAUDE.md", "head\n@./part.md\n");
        const found = await collectNestedNotes(join(root, "a/file.ts"), root);
        expect(found).toHaveLength(1);
        expect(found[0]?.content).toBe("head\nPART\n");
    });

    test("both CLAUDE.md and AGENTS.md in one nested directory are collected", async () => {
        await write("a/CLAUDE.md", "a claude");
        await write("a/AGENTS.md", "a agents");
        const found = await collectNestedNotes(join(root, "a/file.ts"), root);
        expect(found.map((f) => f.content)).toEqual(["a claude", "a agents"]);
    });
});

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

let sessionCounter = 0;

const makeCtx = (): ToolContext => ({
    cwd: root,
    signal: new AbortController().signal,
    sessionId: `nested-notes-session-${sessionCounter++}`,
    projectId: "nested-notes-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    headless: false,
    log: () => {},
});

const readValue = async (path: string, ctx: ToolContext): Promise<string> => {
    const r = await ReadTool.execute({ path }, ctx);
    expect(r.ok).toBe(true);
    return r.ok && typeof r.value === "string" ? r.value : "";
};

describe("Read tool nested notes injection", () => {
    test("appends a system-reminder after the read output, header untouched", async () => {
        await write("a/CLAUDE.md", "nested rules");
        const target = await write("a/file.ts", "line1\nline2\n");
        const value = await readValue(target, makeCtx());

        expect(value.split("\n")[0]).toBe(`<read path="${target}" lines="3" range="1-3">`);
        expect(value).toContain("     1\tline1");
        expect(value).toContain("<system-reminder>");
        expect(value).toContain(join(root, "a/CLAUDE.md"));
        expect(value).toContain("nested rules");
        expect(value.indexOf("<system-reminder>")).toBeGreaterThan(value.indexOf("     2\tline2"));
    });

    test("injects each nested notes file at most once per session", async () => {
        await write("a/CLAUDE.md", "nested rules");
        const first = await write("a/one.ts", "x\n");
        const second = await write("a/two.ts", "y\n");
        const ctx = makeCtx();

        expect(await readValue(first, ctx)).toContain("nested rules");
        expect(await readValue(second, ctx)).not.toContain("nested rules");
    });

    test("a different session gets its own injection", async () => {
        await write("a/CLAUDE.md", "nested rules");
        const target = await write("a/one.ts", "x\n");

        expect(await readValue(target, makeCtx())).toContain("nested rules");
        expect(await readValue(target, makeCtx())).toContain("nested rules");
    });

    test("root-level notes are never injected", async () => {
        await write("CLAUDE.md", "root rules");
        const target = await write("file.ts", "x\n");
        const value = await readValue(target, makeCtx());
        expect(value).not.toContain("<system-reminder>");
        expect(value).not.toContain("root rules");
    });

    test("reading the nested notes file itself does not echo it back", async () => {
        const notes = await write("a/CLAUDE.md", "nested rules");
        const value = await readValue(notes, makeCtx());
        expect(value).not.toContain("<system-reminder>");
    });
});
