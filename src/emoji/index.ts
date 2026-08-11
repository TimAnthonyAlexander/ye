import { searchEmojis } from "./emojiData.ts";

export interface ActiveEmoji {
    readonly start: number; // index of the `:`
    readonly end: number; // index after the last query char
    readonly query: string; // text between `:` and end (or whitespace)
}

// Locate a `:token` whose body contains the cursor. The colon must be at the
// start of input, preceded by whitespace, or preceded by an emoji (surrogate
// pair) — letters and digits before the `:` won't trigger. This lets `😂:jo`
// open the picker while `abc:jo` and `http://x:y` are left alone.
export const findActiveEmoji = (value: string, cursor: number): ActiveEmoji | null => {
    if (cursor <= 0 || cursor > value.length) return null;

    const isWordChar = (ch: string): boolean => ch !== " " && ch !== "\t" && ch !== "\n";
    let i = cursor - 1;
    while (i >= 0 && isWordChar(value[i] ?? "")) i--;
    const tokenStart = i + 1;

    // Find the first `:` within [tokenStart, cursor) whose prefix is valid:
    // nothing (start of token), whitespace, or a surrogate (emoji).
    let colonIdx = -1;
    for (let k = tokenStart; k < cursor; k++) {
        if (value[k] !== ":") continue;
        if (k === tokenStart) {
            colonIdx = k;
            break;
        }
        const prev = value.charCodeAt(k - 1);
        if (value[k - 1] === " " || (prev >= 0xd800 && prev <= 0xdfff)) {
            colonIdx = k;
            break;
        }
    }

    if (colonIdx < 0) return null;
    if (cursor <= colonIdx) return null;

    let j = colonIdx + 1;
    while (j < value.length && isWordChar(value[j] ?? "")) j++;

    return {
        start: colonIdx,
        end: j,
        query: value.slice(colonIdx + 1, cursor),
    };
};

// Up to 4 results, prefix-matched against the query.
export const matchEmojis = (query: string): readonly { char: string; code: string }[] => {
    if (query.length === 0) return [];
    return searchEmojis(query, 4).map((e) => ({ char: e.char, code: e.match }));
};
