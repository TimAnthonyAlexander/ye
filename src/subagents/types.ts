export type SubagentKind = "explore" | "general";

export type ExploreThoroughness = "quick" | "medium" | "very_thorough";

export interface ExploreOptions {
    readonly thoroughness?: ExploreThoroughness;
}

export interface SubagentSpec {
    readonly kind: SubagentKind;
    readonly prompt: string;
    readonly options?: ExploreOptions;
}

export interface SubagentResult {
    readonly summary: string;
    readonly transcriptPath: string;
    readonly turnCount: number;
}

export class SubagentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SubagentError";
    }
}
