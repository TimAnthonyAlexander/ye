// Project file/folder index used by the `@`-mention picker. Files come from
// `rg --files` (which honors .gitignore) with a `Bun.Glob` fallback; folders
// are derived from the unique parent prefixes of the file list.

import type { IndexEntry } from "./types.ts";

const MAX_FILES = 5000;
const MAX_FOLDERS = 2000;

const FALLBACK_EXCLUDE = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    "coverage",
    ".venv",
    "venv",
    "__pycache__",
    "target",
]);

const cache = new Map<string, readonly IndexEntry[]>();
const inflight = new Map<string, Promise<readonly IndexEntry[]>>();

const runRipgrep = async (root: string): Promise<readonly string[] | null> => {
    try {
        const proc = Bun.spawn({
            cmd: ["rg", "--files", "--hidden", "--glob", "!.git"],
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        if (exitCode !== 0) return null;
        const lines = stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        return lines.slice(0, MAX_FILES);
    } catch {
        return null;
    }
};

const runFallback = async (root: string): Promise<readonly string[]> => {
    const out: string[] = [];
    try {
        const glob = new Bun.Glob("**/*");
        for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
            const segments = rel.split("/");
            if (segments.some((s) => FALLBACK_EXCLUDE.has(s))) continue;
            out.push(rel);
            if (out.length >= MAX_FILES) break;
        }
    } catch {
        // ignore — return whatever we collected
    }
    return out;
};

const deriveFolders = (files: readonly string[]): string[] => {
    const set = new Set<string>();
    for (const f of files) {
        const segments = f.split("/");
        for (let i = 1; i < segments.length; i++) {
            set.add(segments.slice(0, i).join("/") + "/");
            if (set.size >= MAX_FOLDERS) break;
        }
        if (set.size >= MAX_FOLDERS) break;
    }
    return [...set].sort();
};

const buildIndex = (files: readonly string[]): readonly IndexEntry[] => {
    const folders = deriveFolders(files);
    const entries: IndexEntry[] = [];
    for (const path of folders) entries.push({ path, kind: "folder" });
    for (const path of files) entries.push({ path, kind: "file" });
    return entries;
};

export const loadFileIndex = async (root: string): Promise<readonly IndexEntry[]> => {
    const cached = cache.get(root);
    if (cached) return cached;
    const pending = inflight.get(root);
    if (pending) return pending;

    const promise = (async () => {
        const fromRg = await runRipgrep(root);
        const files = fromRg ?? (await runFallback(root));
        const result = buildIndex(files);
        cache.set(root, result);
        inflight.delete(root);
        return result;
    })();
    inflight.set(root, promise);
    return promise;
};

export const refreshFileIndex = (root: string): void => {
    cache.delete(root);
    inflight.delete(root);
};

export { findActiveMention } from "./parse.ts";
export { matchFiles } from "./match.ts";
export { expandMentions } from "./expand.ts";
export type { ActiveMention, IndexEntry, MentionOption } from "./types.ts";
