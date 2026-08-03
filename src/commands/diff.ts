import { $ } from "bun";
import { gapMarker, type DiffSegment } from "../components/editDiff.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const MAX_LINE_WIDTH = 120;
const MAX_TOTAL_LINES = 400;
const MAX_FILE_LINES = 80;
const MAX_UNTRACKED = 10;

export interface FileDiff {
    readonly path: string;
    readonly note: string | null;
    readonly added: number;
    readonly removed: number;
    readonly segments: readonly DiffSegment[];
}

export type DiffLineKind = "title" | "file" | "add" | "del" | "context" | "meta";

export interface DiffLine {
    readonly kind: DiffLineKind;
    readonly text: string;
}

interface PendingFile {
    headerPath: string;
    oldPath: string | null;
    newPath: string | null;
    note: string | null;
    added: number;
    removed: number;
    nextLine: number | null;
    segments: DiffSegment[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const unquote = (path: string): string =>
    path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;

// `--- a/x` / `+++ b/x`, with git's optional trailing timestamp column.
const sidePath = (line: string): string | null => {
    const raw = unquote(line.slice(4).split("\t")[0] ?? "");
    if (raw === "/dev/null" || raw.length === 0) return null;
    return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
};

const headerPath = (line: string): string => {
    const rest = line.slice("diff --git ".length);
    const split = rest.indexOf(" b/");
    const raw = split === -1 ? rest : rest.slice(split + 3);
    return unquote(raw);
};

const seal = (file: PendingFile): FileDiff => ({
    path: file.newPath ?? file.oldPath ?? file.headerPath,
    note: file.note,
    added: file.added,
    removed: file.removed,
    segments: file.segments,
});

export const parseUnifiedDiff = (raw: string): readonly FileDiff[] => {
    const files: FileDiff[] = [];
    let cur: PendingFile | null = null;

    for (const line of raw.split("\n")) {
        if (line.startsWith("diff --git ")) {
            if (cur !== null) files.push(seal(cur));
            cur = {
                headerPath: headerPath(line),
                oldPath: null,
                newPath: null,
                note: null,
                added: 0,
                removed: 0,
                nextLine: null,
                segments: [],
            };
            continue;
        }
        if (cur === null) continue;

        if (line.startsWith("--- ")) {
            cur.oldPath = sidePath(line);
            continue;
        }
        if (line.startsWith("+++ ")) {
            cur.newPath = sidePath(line);
            continue;
        }
        if (line.startsWith("new file mode")) {
            cur.note = "new file";
            continue;
        }
        if (line.startsWith("deleted file mode")) {
            cur.note = "deleted";
            continue;
        }
        if (line.startsWith("rename to ")) {
            cur.note = "renamed";
            continue;
        }
        if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
            cur.note = "binary";
            continue;
        }

        const hunk = HUNK.exec(line);
        if (hunk !== null) {
            const start = Number(hunk[3]);
            const count = hunk[4] === undefined ? 1 : Number(hunk[4]);
            if (cur.nextLine !== null && start > cur.nextLine) {
                cur.segments.push(gapMarker(start - cur.nextLine));
            }
            cur.nextLine = start + count;
            continue;
        }
        if (cur.nextLine === null) continue;

        if (line.startsWith("+")) {
            cur.added += 1;
            cur.segments.push({ type: "add", line: line.slice(1) });
            continue;
        }
        if (line.startsWith("-")) {
            cur.removed += 1;
            cur.segments.push({ type: "del", line: line.slice(1) });
            continue;
        }
        if (line.startsWith(" ")) {
            cur.segments.push({ type: "eq", line: line.slice(1) });
        }
    }

    if (cur !== null) files.push(seal(cur));
    return files;
};

const clip = (line: string): string =>
    line.length > MAX_LINE_WIDTH ? `${line.slice(0, MAX_LINE_WIDTH)}…` : line;

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

const segmentLine = (seg: DiffSegment): DiffLine => {
    if (seg.type === "add") return { kind: "add", text: `    + ${clip(seg.line)}` };
    if (seg.type === "del") return { kind: "del", text: `    - ${clip(seg.line)}` };
    if (seg.type === "gap") return { kind: "context", text: `    ${seg.line}` };
    return { kind: "context", text: `      ${clip(seg.line)}` };
};

export interface RenderDiffOptions {
    readonly maxTotalLines?: number;
    readonly maxFileLines?: number;
    readonly untracked?: readonly string[];
}

export const renderDiffLines = (
    files: readonly FileDiff[],
    opts: RenderDiffOptions = {},
): readonly DiffLine[] => {
    const maxTotal = opts.maxTotalLines ?? MAX_TOTAL_LINES;
    const maxFile = opts.maxFileLines ?? MAX_FILE_LINES;
    const untracked = opts.untracked ?? [];

    const added = files.reduce((sum, f) => sum + f.added, 0);
    const removed = files.reduce((sum, f) => sum + f.removed, 0);
    const lines: DiffLine[] = [
        { kind: "title", text: `${plural(files.length, "file")} changed, +${added} -${removed}` },
    ];

    let budget = maxTotal;
    let skipped = 0;
    for (const file of files) {
        if (budget <= 1) {
            skipped += 1;
            continue;
        }
        const note = file.note === null ? "" : ` (${file.note})`;
        lines.push({
            kind: "file",
            text: `  ${file.path}  +${file.added} -${file.removed}${note}`,
        });
        budget -= 1;
        const shown = file.segments.slice(0, Math.min(budget, maxFile));
        for (const seg of shown) lines.push(segmentLine(seg));
        budget -= shown.length;
        const rest = file.segments.length - shown.length;
        if (rest > 0) lines.push({ kind: "meta", text: `    … ${plural(rest, "line")} elided` });
    }
    if (skipped > 0) {
        lines.push({ kind: "meta", text: `… ${plural(skipped, "file")} not shown` });
    }

    if (untracked.length > 0) {
        const shown = untracked.slice(0, MAX_UNTRACKED);
        const rest = untracked.length - shown.length;
        const more = rest > 0 ? `, +${rest} more` : "";
        lines.push({ kind: "meta", text: `untracked: ${shown.join(", ")}${more}` });
    }
    return lines;
};

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DEFAULT_FG = "\x1b[39m";

const paint = (line: DiffLine): string => {
    if (line.kind === "add") return `${GREEN}${line.text}${DEFAULT_FG}`;
    if (line.kind === "del") return `${RED}${line.text}${DEFAULT_FG}`;
    return line.text;
};

export const paintDiffLines = (lines: readonly DiffLine[]): string => lines.map(paint).join("\n");

interface GitRun {
    readonly ok: boolean;
    readonly stdout: string;
}

const git = async (root: string, args: readonly string[]): Promise<GitRun> => {
    try {
        const proc = await $`git -C ${root} ${args}`.quiet().nothrow();
        return { ok: proc.exitCode === 0, stdout: proc.stdout.toString() };
    } catch {
        return { ok: false, stdout: "" };
    }
};

export const DiffCommand: SlashCommand = {
    name: "diff",
    description: "Show the uncommitted changes in the working tree.",
    execute: async (_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const root = ctx.projectRoot;
        const inRepo = await git(root, ["rev-parse", "--is-inside-work-tree"]);
        if (!inRepo.ok) return { kind: "error", message: `${root} is not a git repository.` };

        const [diff, others] = await Promise.all([
            git(root, ["diff", "HEAD"]),
            git(root, ["ls-files", "--others", "--exclude-standard"]),
        ]);
        const untracked = others.stdout.split("\n").filter((path) => path.length > 0);
        const files = parseUnifiedDiff(diff.stdout);

        if (files.length === 0 && untracked.length === 0) {
            const clean = diff.ok
                ? "Working tree clean — nothing uncommitted."
                : "No commits yet, and nothing uncommitted.";
            ctx.addSystemMessage(clean);
            return { kind: "ok" };
        }

        ctx.addSystemMessage(paintDiffLines(renderDiffLines(files, { untracked })));
        return { kind: "ok" };
    },
};
