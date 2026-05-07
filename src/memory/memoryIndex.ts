import { dirname, isAbsolute, resolve } from "node:path";

export interface MemoryEntry {
    readonly path: string;
    readonly title: string;
    readonly hook: string;
}

const ENTRY_RE = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]+\s*(.+))?$/;

const parseLines = (text: string, baseDir: string): MemoryEntry[] => {
    const out: MemoryEntry[] = [];
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        const m = ENTRY_RE.exec(line);
        if (!m) continue;
        const title = (m[1] ?? "").trim();
        const rawPath = (m[2] ?? "").trim();
        const hook = (m[3] ?? "").trim();
        if (rawPath.length === 0) continue;
        const path = isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
        out.push({ path, title, hook });
    }
    return out;
};

export const parseMemoryIndex = async (indexPath: string): Promise<readonly MemoryEntry[]> => {
    const file = Bun.file(indexPath);
    if (!(await file.exists())) return [];
    try {
        const text = await file.text();
        return parseLines(text, dirname(indexPath));
    } catch {
        return [];
    }
};
