import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HISTORY_FILE } from "./paths.ts";

interface HistoryEntry {
    readonly ts: string;
    readonly cwd: string;
    readonly text: string;
}

const MAX_RETURNED_ENTRIES = 1000;

const isNotFoundError = (err: unknown): boolean =>
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";

// Returns prompt history newest-first, capped at MAX_RETURNED_ENTRIES.
// Corrupt JSONL lines are skipped silently — history is best-effort UX.
export const loadHistory = async (): Promise<readonly string[]> => {
    let raw: string;
    try {
        raw = await readFile(HISTORY_FILE, "utf8");
    } catch (err) {
        if (isNotFoundError(err)) return [];
        throw err;
    }

    const entries: string[] = [];
    for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        try {
            const parsed = JSON.parse(line) as Partial<HistoryEntry>;
            if (typeof parsed.text === "string" && parsed.text.length > 0) {
                entries.push(parsed.text);
            }
        } catch {
            continue;
        }
    }

    return entries.reverse().slice(0, MAX_RETURNED_ENTRIES);
};

export const appendHistory = async (text: string): Promise<void> => {
    if (text.length === 0) return;
    const entry: HistoryEntry = {
        ts: new Date().toISOString(),
        cwd: process.cwd(),
        text,
    };
    await mkdir(dirname(HISTORY_FILE), { recursive: true });
    await appendFile(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
};
