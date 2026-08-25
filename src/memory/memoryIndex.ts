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

// Drop every index entry pointing at `filename`. Index-format knowledge stays
// in this module, so removing a memory cannot invent a second parser that
// disagrees with the one auto-selection reads with.
export const removeMemoryEntry = (
    text: string,
    filename: string,
): { readonly text: string; readonly removed: number } => {
    let removed = 0;
    const kept = text.split("\n").filter((rawLine) => {
        const m = ENTRY_RE.exec(rawLine.trim());
        const target = m?.[2]?.trim();
        if (target === undefined || target !== filename) return true;
        removed += 1;
        return false;
    });
    return { text: kept.join("\n"), removed };
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
