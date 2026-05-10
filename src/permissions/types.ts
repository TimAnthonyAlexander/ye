import type { PermissionMode, PermissionRule } from "../config/index.ts";

export type { PermissionMode, PermissionRule };

export interface ToolCall {
    readonly id: string;
    readonly name: string;
    readonly args: unknown;
}

// Structured "why are we prompting" metadata. Populated when a deterministic
// heuristic elevates an otherwise-allowed call to a prompt — surfaced in the
// UI so the user can see *which* pattern fired (e.g. "git push with --force").
export interface HeuristicReason {
    readonly id: string;
    readonly label: string;
}

export type Decision =
    | { readonly kind: "allow" }
    | { readonly kind: "deny"; readonly message: string }
    | { readonly kind: "prompt"; readonly promptReason?: HeuristicReason };

export type PromptResponse = "allow_once" | "allow_session" | "deny";
