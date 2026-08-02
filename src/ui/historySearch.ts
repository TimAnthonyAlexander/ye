// `history` arrives newest-first (see storage/history.ts), so match order is
// already most-recent-first. Repeats are collapsed to the newest occurrence —
// cycling through five identical prompts is never what the user wants.
export const searchHistory = (history: readonly string[], query: string): readonly string[] => {
    const q = query.toLowerCase();
    const seen = new Set<string>();
    const matches: string[] = [];
    for (const entry of history) {
        if (q.length > 0 && !entry.toLowerCase().includes(q)) continue;
        if (seen.has(entry)) continue;
        seen.add(entry);
        matches.push(entry);
    }
    return matches;
};

export const cycleMatch = (matchCount: number, current: number): number =>
    matchCount <= 0 ? 0 : (current + 1) % matchCount;

export const previewEntry = (text: string): string => text.replace(/\s+/g, " ").trim();

export interface MatchHighlight {
    readonly before: string;
    readonly hit: string;
    readonly after: string;
}

export const highlightMatch = (text: string, query: string): MatchHighlight => {
    const at = query.length === 0 ? -1 : text.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0) return { before: text, hit: "", after: "" };
    return {
        before: text.slice(0, at),
        hit: text.slice(at, at + query.length),
        after: text.slice(at + query.length),
    };
};
