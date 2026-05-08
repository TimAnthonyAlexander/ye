import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface GlobArgs {
    readonly pattern: string;
    readonly path?: string;
}

const RESULT_CAP = 200;

// Directories we never descend into. These are filesystem noise that would
// pollute results from $HOME and, on macOS, are a frequent EACCES source on
// SIP-protected subtrees (e.g. ~/Library/Group Containers).
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

interface FileMatch {
    readonly path: string;
    readonly mtimeMs: number;
}

const collectMatches = async (root: string, glob: Bun.Glob): Promise<FileMatch[]> => {
    const matches: FileMatch[] = [];
    const stack: string[] = [root];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            // EACCES, EPERM, ENOENT, ENOTDIR — skip silently and continue.
            // Walking from $HOME often hits macOS-protected paths; those
            // shouldn't crash a code search.
            continue;
        }
        for (const ent of entries) {
            if (ent.isDirectory()) {
                if (SKIP_DIRS.has(ent.name)) continue;
                stack.push(join(dir, ent.name));
                continue;
            }
            if (!ent.isFile()) continue;
            const full = join(dir, ent.name);
            const rel = relative(root, full);
            if (!glob.match(rel)) continue;
            try {
                const s = await stat(full);
                matches.push({ path: full, mtimeMs: s.mtimeMs });
            } catch {
                // race or permissions — skip
            }
        }
    }
    return matches;
};

const execute = async (
    rawArgs: unknown,
    ctx: ToolContext,
): Promise<ToolResult<{ paths: string[]; truncated: boolean }>> => {
    const v = validateArgs<GlobArgs>(rawArgs, GlobTool.schema);
    if (!v.ok) return v;
    const { pattern, path } = v.value;

    const root = path ? (isAbsolute(path) ? path : join(ctx.cwd, path)) : ctx.cwd;
    const glob = new Bun.Glob(pattern);

    const matches = await collectMatches(root, glob);
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const truncated = matches.length > RESULT_CAP;
    const paths = (truncated ? matches.slice(0, RESULT_CAP) : matches).map((m) => m.path);
    return { ok: true, value: { paths, truncated } };
};

export const GlobTool: Tool = {
    name: "Glob",
    description:
        "Match files by glob pattern (e.g. `**/*.ts`). Returns absolute paths sorted by mtime descending. " +
        "Search root defaults to cwd; pass `path` to override. " +
        "Skips common noise (.git, node_modules, Library, .Trash, etc.) and tolerates permission errors silently.",
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["pattern"],
        properties: {
            pattern: { type: "string" },
            path: { type: "string" },
        },
    },
    execute,
};
