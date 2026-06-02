import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

export type GrepMode = "content" | "files_with_matches" | "count";

export interface FallbackArgs {
    readonly pattern: string;
    readonly root: string; // resolved absolute path (file or dir)
    readonly mode: GrepMode;
    readonly type?: string;
    readonly glob?: string;
    readonly signal: AbortSignal;
}

// Mirrors the Glob tool's noise set so the two search tools agree on what to
// skip. Kept local to avoid coupling the two modules.
const SKIP_DIRS: ReadonlySet<string> = new Set([
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".cache",
    ".npm",
    ".bun",
    ".Trash",
    "Library",
    "Applications",
    ".vscode-server",
    ".cursor-server",
]);

// Common ripgrep `--type` names → file extensions. Covers the types the model
// reaches for; an unknown type falls back to matching that string as a literal
// extension.
const TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
    ts: ["ts", "tsx", "mts", "cts"],
    tsx: ["tsx"],
    js: ["js", "jsx", "mjs", "cjs"],
    jsx: ["jsx"],
    py: ["py", "pyi"],
    rust: ["rs"],
    go: ["go"],
    java: ["java"],
    c: ["c", "h"],
    cpp: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
    css: ["css", "scss", "sass", "less"],
    html: ["html", "htm"],
    json: ["json"],
    md: ["md", "markdown"],
    sh: ["sh", "bash", "zsh"],
    rb: ["rb"],
    php: ["php"],
    yaml: ["yaml", "yml"],
    toml: ["toml"],
    xml: ["xml"],
};

const MAX_FILE_BYTES = 20_000_000;
const NUL = "\u0000";

const extOf = (name: string): string => {
    const dot = name.lastIndexOf(".");
    return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

const typeMatches = (name: string, type: string): boolean => {
    const exts = TYPE_EXTENSIONS[type] ?? [type];
    return exts.includes(extOf(name));
};

// ripgrep's `-g` matches anywhere in the tree for bare patterns like `*.ts`, so
// match the basename when the glob has no separator, otherwise the rel path.
const globMatches = (rel: string, name: string, glob: Bun.Glob, raw: string): boolean =>
    raw.includes("/") ? glob.match(rel) : glob.match(name);

const isProbablyBinary = (text: string): boolean => text.includes(NUL);

interface FileHit {
    readonly display: string;
    readonly lines: readonly { readonly no: number; readonly text: string }[];
}

const collectFiles = async (
    root: string,
    isDir: boolean,
    type: string | undefined,
    glob: Bun.Glob | undefined,
    rawGlob: string | undefined,
    signal: AbortSignal,
): Promise<string[]> => {
    if (!isDir) return [root];
    const files: string[] = [];
    const stack: string[] = [root];
    while (stack.length > 0) {
        if (signal.aborted) break;
        const dir = stack.pop()!;
        let entries: Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            if (ent.isDirectory()) {
                if (SKIP_DIRS.has(ent.name)) continue;
                stack.push(join(dir, ent.name));
                continue;
            }
            if (!ent.isFile()) continue;
            if (type && !typeMatches(ent.name, type)) continue;
            const full = join(dir, ent.name);
            if (glob && rawGlob && !globMatches(relative(root, full), ent.name, glob, rawGlob)) {
                continue;
            }
            files.push(full);
        }
    }
    return files;
};

const searchFile = async (full: string, display: string, re: RegExp): Promise<FileHit | null> => {
    let s;
    try {
        s = await stat(full);
    } catch {
        return null;
    }
    if (s.size > MAX_FILE_BYTES) return null;
    let text: string;
    try {
        text = await Bun.file(full).text();
    } catch {
        return null;
    }
    if (isProbablyBinary(text)) return null;
    const hits: { no: number; text: string }[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        re.lastIndex = 0;
        if (re.test(line)) hits.push({ no: i + 1, text: line });
    }
    return hits.length > 0 ? { display, lines: hits } : null;
};

export const grepFallback = async (args: FallbackArgs): Promise<string> => {
    let re: RegExp;
    try {
        re = new RegExp(args.pattern);
    } catch (e) {
        throw new Error(`invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }

    let isDir = false;
    try {
        isDir = (await stat(args.root)).isDirectory();
    } catch {
        throw new Error(`path not found: ${args.root}`);
    }

    const glob = args.glob ? new Bun.Glob(args.glob) : undefined;
    const files = await collectFiles(args.root, isDir, args.type, glob, args.glob, args.signal);

    const hits: FileHit[] = [];
    for (const full of files) {
        if (args.signal.aborted) break;
        const display = isDir ? relative(args.root, full) || basename(full) : basename(full);
        const hit = await searchFile(full, display, re);
        if (hit) hits.push(hit);
    }

    return formatHits(hits, args.mode, isDir);
};

const formatHits = (hits: readonly FileHit[], mode: GrepMode, isDir: boolean): string => {
    switch (mode) {
        case "files_with_matches":
            return hits.map((h) => h.display).join("\n");
        case "count":
            return hits.map((h) => `${h.display}:${h.lines.length}`).join("\n");
        case "content":
            return hits
                .flatMap((h) =>
                    h.lines.map((l) =>
                        isDir ? `${h.display}:${l.no}:${l.text}` : `${l.no}:${l.text}`,
                    ),
                )
                .join("\n");
    }
};
