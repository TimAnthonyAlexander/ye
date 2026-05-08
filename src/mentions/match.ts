import type { IndexEntry, MentionOption } from "./types.ts";

const FOLDER_BONUS = 5;
const LITERAL_SUBSTRING_BONUS = 4;

// Subsequence fuzzy ranker. Each query character must appear in `path` in
// order; otherwise the path is filtered out. Score components:
//   - shorter paths win (small penalty per char)
//   - matches inside the basename are weighted heavily
//   - matches at a segment boundary (after `/`, `-`, `_`, `.`) get a bonus
//   - contiguous runs get a bonus
// For folder paths (those ending in `/`), the basename is the segment before
// the trailing slash — otherwise the trailing `/` would push every char out
// of the basename window.
const score = (query: string, path: string): number | null => {
    if (query.length === 0) return 0;
    const q = query.toLowerCase();
    const p = path.toLowerCase();

    const positions: number[] = [];
    let qi = 0;
    for (let i = 0; i < p.length && qi < q.length; i++) {
        if (p[i] === q[qi]) {
            positions.push(i);
            qi++;
        }
    }
    if (qi < q.length) return null;

    const trailingSlash = p.endsWith("/");
    const lastSlash = trailingSlash ? p.lastIndexOf("/", p.length - 2) : p.lastIndexOf("/");
    const basenameStart = lastSlash + 1;
    const basenameEnd = trailingSlash ? p.length - 1 : p.length;

    let s = -p.length * 0.5;
    for (let k = 0; k < positions.length; k++) {
        const pos = positions[k] ?? 0;
        if (pos >= basenameStart && pos < basenameEnd) s += 5;
        const prev = pos === 0 ? "/" : (p[pos - 1] ?? "");
        if (prev === "/" || prev === "-" || prev === "_" || prev === ".") s += 3;
        if (k > 0 && pos === (positions[k - 1] ?? -2) + 1) s += 2;
    }
    return s;
};

const toOption = (entry: IndexEntry): MentionOption => {
    if (entry.kind === "folder") {
        const stripped = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
        const idx = stripped.lastIndexOf("/");
        return {
            id: `${stripped}/`,
            kind: "folder",
            basename: `${idx >= 0 ? stripped.slice(idx + 1) : stripped}/`,
            parent: idx >= 0 ? stripped.slice(0, idx + 1) : "",
        };
    }
    const idx = entry.path.lastIndexOf("/");
    return {
        id: entry.path,
        kind: "file",
        basename: idx >= 0 ? entry.path.slice(idx + 1) : entry.path,
        parent: idx >= 0 ? entry.path.slice(0, idx + 1) : "",
    };
};

const emptyQueryOrder = (index: readonly IndexEntry[]): readonly IndexEntry[] => {
    // Top-level entries first (no `/` in the path body), so an empty `@` shows
    // the project root rather than burying it under deep folders.
    const top: IndexEntry[] = [];
    const rest: IndexEntry[] = [];
    for (const e of index) {
        const body = e.path.endsWith("/") ? e.path.slice(0, -1) : e.path;
        if (!body.includes("/")) top.push(e);
        else rest.push(e);
    }
    return [...top, ...rest];
};

export const matchFiles = (
    query: string,
    index: readonly IndexEntry[],
    limit: number,
): readonly MentionOption[] => {
    if (index.length === 0) return [];

    // Trailing `/` on the query flips the picker into folder-only mode and
    // promotes entries that contain the slash-stripped query as a literal
    // substring — that's the "exact match" feel when drilling into a folder.
    const folderOnly = query.endsWith("/");
    const effective = folderOnly ? query.slice(0, -1) : query;

    if (effective.length === 0) {
        const ordered = emptyQueryOrder(index);
        const filtered = folderOnly ? ordered.filter((e) => e.kind === "folder") : ordered;
        return filtered.slice(0, limit).map(toOption);
    }

    const literal = effective.toLowerCase();
    const scored: { entry: IndexEntry; s: number }[] = [];
    for (const entry of index) {
        if (folderOnly && entry.kind !== "folder") continue;
        const s = score(effective, entry.path);
        if (s === null) continue;
        let total = s;
        if (entry.kind === "folder") total += FOLDER_BONUS;
        if (entry.path.toLowerCase().includes(literal)) total += LITERAL_SUBSTRING_BONUS;
        scored.push({ entry, s: total });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => toOption(x.entry));
};
