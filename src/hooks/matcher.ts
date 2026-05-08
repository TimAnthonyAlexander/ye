import type { MatcherGroup } from "./types.ts";

export const matchGroups = (
    groups: readonly MatcherGroup[] | undefined,
    toolName: string | undefined,
): readonly MatcherGroup[] => {
    if (!groups) return [];

    return groups.filter((g) => {
        if (!g.matcher) return true; // no matcher = match everything
        if (toolName === undefined) return false;
        try {
            return new RegExp(g.matcher).test(toolName);
        } catch {
            return false; // invalid regex = no match
        }
    });
};
