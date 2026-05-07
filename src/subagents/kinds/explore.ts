import type { ExploreThoroughness } from "../types.ts";
import { buildExplorePrompt } from "../systemPrompts.ts";

export const EXPLORE_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];

export const exploreTurnBudget = (thoroughness: ExploreThoroughness | undefined): number => {
    switch (thoroughness) {
        case "quick":
            return 5;
        case "very_thorough":
            return 25;
        case "medium":
        default:
            return 15;
    }
};

export const exploreSystemPrompt = (cwd: string): string => buildExplorePrompt(cwd, EXPLORE_TOOLS);
