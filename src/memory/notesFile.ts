import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type NotesFormat = "claude" | "ye" | "agents";

export interface ProjectNotesFile {
    readonly path: string;
    readonly existed: boolean;
    readonly format: NotesFormat;
}

const CLAUDE_NAME = "CLAUDE.md";
const YE_NAME = "YE.md";
const AGENTS_NAME = "AGENTS.md";

const PROJECT_CANDIDATES: readonly (readonly [string, NotesFormat])[] = [
    [CLAUDE_NAME, "claude"],
    [YE_NAME, "ye"],
    [AGENTS_NAME, "agents"],
];

// THE centralizer. The single source of truth for choosing between
// CLAUDE.md, YE.md and AGENTS.md as the project notes file. No other
// module in Ye should make this decision. First found wins — the files
// are alternatives, never concatenated.
export const getProjectNotesFile = (projectRoot: string): ProjectNotesFile => {
    for (const [name, format] of PROJECT_CANDIDATES) {
        const path = join(projectRoot, name);
        if (existsSync(path)) return { path, existed: true, format };
    }
    // None exist. If we ever need to write project notes, we create YE.md.
    return { path: join(projectRoot, YE_NAME), existed: false, format: "ye" };
};

export const LOCAL_NOTES_NAME = "YE.local.md";

const IMPORT_MAX_DEPTH = 4;

const IMPORT_RE = /^\s*@(\S+)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

const looksLikePath = (spec: string): boolean => spec.includes("/") || spec.endsWith(".md");

const resolveImport = (spec: string, fromDir: string): string => {
    if (spec === "~") return homedir();
    if (spec.startsWith("~/")) return join(homedir(), spec.slice(2));
    if (isAbsolute(spec)) return spec;
    return resolve(fromDir, spec);
};

const readText = async (path: string): Promise<string | null> => {
    try {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        return await file.text();
    } catch {
        return null;
    }
};

const expandImports = async (
    content: string,
    fromDir: string,
    depth: number,
    chain: ReadonlySet<string>,
): Promise<string> => {
    if (depth >= IMPORT_MAX_DEPTH) return content;

    const out: string[] = [];
    let fence: string | null = null;

    for (const line of content.split("\n")) {
        const fenceMatch = FENCE_RE.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[1]!;
            if (fence === null) fence = marker;
            else if (fence === marker) fence = null;
            out.push(line);
            continue;
        }
        if (fence !== null) {
            out.push(line);
            continue;
        }

        const match = IMPORT_RE.exec(line);
        const spec = match?.[1];
        if (!spec || !looksLikePath(spec)) {
            out.push(line);
            continue;
        }

        const target = resolveImport(spec, fromDir);
        if (chain.has(target)) {
            out.push(line);
            continue;
        }
        const imported = await readText(target);
        if (imported === null) {
            out.push(line);
            continue;
        }

        out.push(
            await expandImports(
                imported.replace(/\n+$/, ""),
                dirname(target),
                depth + 1,
                new Set([...chain, target]),
            ),
        );
    }

    return out.join("\n");
};

// Reads a notes file and inlines its `@path` imports. Returns null when the
// file is absent, unreadable or blank. Broken imports are left as literal
// text — user-authored notes must never break a session.
export const readNotesWithImports = async (path: string): Promise<string | null> => {
    const content = await readText(path);
    if (content === null || content.trim().length === 0) return null;
    return expandImports(content, dirname(path), 0, new Set([resolve(path)]));
};

export interface NestedNotes {
    readonly path: string;
    readonly content: string;
}

const NESTED_NAMES: readonly string[] = [CLAUDE_NAME, AGENTS_NAME];

// Notes files sitting above `filePath` and below the project root, ordered
// outermost first so the most specific notes land last. Root-level notes are
// skipped: the hierarchy already picked exactly one of them, and re-adding a
// sibling here would undo that precedence.
export const collectNestedNotes = async (
    filePath: string,
    projectRoot: string,
): Promise<readonly NestedNotes[]> => {
    const root = resolve(projectRoot);
    const target = resolve(filePath);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) return [];

    const dirs: string[] = [];
    let dir = dirname(target);
    while (dir !== root) {
        dirs.push(dir);
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    const found: NestedNotes[] = [];
    for (const d of dirs.reverse()) {
        for (const name of NESTED_NAMES) {
            const path = join(d, name);
            const content = await readNotesWithImports(path);
            if (content !== null) found.push({ path, content });
        }
    }
    return found;
};
