import type { MentionOption } from "./types.ts";

// Subsequence fuzzy ranker. Each query character must appear in `path` in
// order; otherwise the path is filtered out. Score components:
//   - shorter paths win (small penalty per char)
//   - matches inside the basename are weighted heavily
//   - matches at a segment boundary (after `/`, `-`, `_`, `.`) get a bonus
//   - contiguous runs get a bonus
// Empty query: every path matches with score 0 (preserves index order).
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

    const lastSlash = p.lastIndexOf("/");
    const basenameStart = lastSlash + 1;

    let s = -p.length * 0.5;
    for (let k = 0; k < positions.length; k++) {
        const pos = positions[k] ?? 0;
        if (pos >= basenameStart) s += 5;
        const prev = pos === 0 ? "/" : (p[pos - 1] ?? "");
        if (prev === "/" || prev === "-" || prev === "_" || prev === ".") s += 3;
        if (k > 0 && pos === (positions[k - 1] ?? -2) + 1) s += 2;
    }
    return s;
};

const toOption = (path: string): MentionOption => {
    const idx = path.lastIndexOf("/");
    return {
        id: path,
        basename: idx >= 0 ? path.slice(idx + 1) : path,
        parent: idx >= 0 ? path.slice(0, idx + 1) : "",
    };
};

export const matchFiles = (
    query: string,
    index: readonly string[],
    limit: number,
): readonly MentionOption[] => {
    if (index.length === 0) return [];

    if (query.length === 0) {
        return index.slice(0, limit).map(toOption);
    }

    const scored: { path: string; s: number }[] = [];
    for (const path of index) {
        const s = score(query, path);
        if (s === null) continue;
        scored.push({ path, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => toOption(x.path));
};
