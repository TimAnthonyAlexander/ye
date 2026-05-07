// Project file index used by the `@`-mention picker. Prefers `rg --files`
// (which honors .gitignore) and falls back to `Bun.Glob` with a hardcoded
// exclude list when ripgrep is unavailable or fails.

const MAX_FILES = 5000;

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

const cache = new Map<string, readonly string[]>();
const inflight = new Map<string, Promise<readonly string[]>>();

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

export const loadFileIndex = async (root: string): Promise<readonly string[]> => {
    const cached = cache.get(root);
    if (cached) return cached;
    const pending = inflight.get(root);
    if (pending) return pending;

    const promise = (async () => {
        const fromRg = await runRipgrep(root);
        const result = fromRg ?? (await runFallback(root));
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
export type { ActiveMention, MentionOption } from "./types.ts";
