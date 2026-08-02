import type { Message } from "../providers/index.ts";

export const BUILTIN_KINDS = ["explore", "general", "verification", "fork"] as const;

export type BuiltinKind = (typeof BUILTIN_KINDS)[number];

// Custom agents come from user-authored markdown, so the kind is an open
// string; every entry point validates it against the live catalogue.
export type SubagentKind = string;

export type AgentSource = "builtin" | "project" | "user";

export type ExploreThoroughness = "quick" | "medium" | "very_thorough";

export interface ExploreOptions {
    readonly thoroughness?: ExploreThoroughness;
}

export interface SubagentSpec {
    readonly kind: SubagentKind;
    readonly prompt: string;
    readonly options?: ExploreOptions;
    // fork only: the parent conversation the fork starts from. Deep-copied
    // during resolution so the fork's shapers can never write back into it.
    readonly seedHistory?: readonly Message[];
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
