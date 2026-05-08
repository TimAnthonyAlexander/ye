import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { hashContent } from "../tools/fs.ts";

const MAX_FILE_LINES = 1000;
const MAX_FOLDER_ENTRIES = 80;
const MAX_TOTAL_BYTES = 256 * 1024;

interface MentionToken {
    readonly raw: string;
}

export interface ExpandedAttachment {
    readonly raw: string;
    readonly abs: string;
    readonly kind: "file" | "folder";
    readonly totalLines?: number;
    readonly shownLines?: number;
    readonly truncated?: boolean;
    readonly entryCount?: number;
}

// Files whose full contents were injected into the prompt and should count
// toward the read-before-edit invariant. Excludes folders, truncated files
// (model only saw the first MAX_FILE_LINES), and byte-budget-omitted files.
export interface MentionRead {
    readonly abs: string;
    readonly hash: string;
}

export interface ExpandedMentions {
    readonly text: string;
    readonly attachments: readonly ExpandedAttachment[];
    readonly reads: readonly MentionRead[];
}

const extractMentions = (text: string): readonly MentionToken[] => {
    const out: MentionToken[] = [];
    const seen = new Set<string>();
    const re = /(^|\s)@([^\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const token = (m[2] ?? "").replace(/[.,;:!?]+$/, "");
        if (token.length === 0) continue;
        if (seen.has(token)) continue;
        seen.add(token);
        out.push({ raw: token });
    }
    return out;
};

const isUnder = (root: string, abs: string): boolean => {
    const rel = relative(root, abs);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
};

interface FileRead {
    readonly content: string;
    readonly total: number;
    readonly shown: number;
    readonly truncated: boolean;
    readonly hash: string;
}

const readFileTruncated = async (abs: string): Promise<FileRead> => {
    const buf = await fs.readFile(abs, "utf8");
    const lines = buf.split("\n");
    const total = lines.length;
    const truncated = total > MAX_FILE_LINES;
    const shown = truncated ? MAX_FILE_LINES : total;
    return {
        content: truncated ? lines.slice(0, MAX_FILE_LINES).join("\n") : buf,
        total,
        shown,
        truncated,
        hash: hashContent(buf),
    };
};

const readFolderListing = async (abs: string): Promise<readonly string[]> => {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    const out: string[] = [];
    for (const e of entries) {
        if (out.length >= MAX_FOLDER_ENTRIES) break;
        out.push(e.isDirectory() ? `${e.name}/` : e.name);
    }
    if (entries.length > out.length) {
        out.push(`…and ${entries.length - out.length} more`);
    }
    return out;
};

// Resolve `@<path>` tokens against the project root and append a
// <mentioned-files> block to the prompt. Files are read up to MAX_FILE_LINES;
// folders get an immediate-children listing. Anything that resolves outside
// the project root, or doesn't exist, is silently skipped — keeps casual
// `@user@host` style strings from breaking the flow. Returns both the
// expanded text and the list of resolved attachments so the caller can render
// "Read" action lines for each one.
export const expandMentions = async (
    text: string,
    projectRoot: string,
): Promise<ExpandedMentions> => {
    const mentions = extractMentions(text);
    if (mentions.length === 0) return { text, attachments: [], reads: [] };

    const sections: string[] = [];
    const attachments: ExpandedAttachment[] = [];
    const reads: MentionRead[] = [];
    let totalBytes = 0;

    for (const m of mentions) {
        const abs = resolve(projectRoot, m.raw);
        if (!isUnder(projectRoot, abs)) continue;

        let stat;
        try {
            stat = await fs.stat(abs);
        } catch {
            continue;
        }

        if (stat.isDirectory()) {
            try {
                const entries = await readFolderListing(abs);
                const body = entries.join("\n");
                sections.push(`<file path="${m.raw}" type="folder">\n${body}\n</file>`);
                attachments.push({
                    raw: m.raw,
                    abs,
                    kind: "folder",
                    entryCount: entries.length,
                });
                totalBytes += body.length;
            } catch {
                // skip unreadable directory
            }
        } else if (stat.isFile()) {
            try {
                const r = await readFileTruncated(abs);
                if (totalBytes + r.content.length > MAX_TOTAL_BYTES) {
                    sections.push(
                        `<file path="${m.raw}" type="file" omitted="byte-budget" total-lines="${r.total}" />`,
                    );
                    attachments.push({
                        raw: m.raw,
                        abs,
                        kind: "file",
                        totalLines: r.total,
                        shownLines: 0,
                        truncated: true,
                    });
                    continue;
                }
                const open = r.truncated
                    ? `<file path="${m.raw}" type="file" total-lines="${r.total}" shown-lines="1-${r.shown}" truncated="true">`
                    : `<file path="${m.raw}" type="file" total-lines="${r.total}">`;
                sections.push(`${open}\n${r.content}\n</file>`);
                attachments.push({
                    raw: m.raw,
                    abs,
                    kind: "file",
                    totalLines: r.total,
                    shownLines: r.shown,
                    truncated: r.truncated,
                });
                if (!r.truncated) {
                    reads.push({ abs, hash: r.hash });
                }
                totalBytes += r.content.length;
            } catch {
                // skip unreadable file
            }
        }

        if (totalBytes >= MAX_TOTAL_BYTES) break;
    }

    if (sections.length === 0) return { text, attachments: [], reads: [] };
    return {
        text: `${text}\n\n<mentioned-files>\n${sections.join("\n\n")}\n</mentioned-files>`,
        attachments,
        reads,
    };
};
