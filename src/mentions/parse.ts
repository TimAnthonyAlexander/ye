import type { ActiveMention } from "./types.ts";

const isMentionChar = (ch: string): boolean => !/\s/.test(ch);

// Locate an `@token` whose body contains the cursor. The mention starts at an
// `@` that is either at the start of input or preceded by whitespace; it runs
// to the next whitespace (or end of input). The cursor must sit strictly after
// the `@` and at or before the token's end.
export const findActiveMention = (value: string, cursor: number): ActiveMention | null => {
    if (cursor <= 0 || cursor > value.length) return null;

    let i = cursor - 1;
    while (i >= 0 && isMentionChar(value[i] ?? "")) i--;
    const tokenStart = i + 1;

    if (value[tokenStart] !== "@") return null;

    let j = tokenStart + 1;
    while (j < value.length && isMentionChar(value[j] ?? "")) j++;

    if (cursor <= tokenStart) return null;

    return {
        start: tokenStart,
        end: j,
        query: value.slice(tokenStart + 1, j),
    };
};
