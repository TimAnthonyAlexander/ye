// A file or folder the user can reference via `@`. `id` is the project-relative
// path (forward-slashed, no leading `./`); folders end with a trailing `/`.
// `id` is what gets spliced into the prompt (with an `@` prefix added at insert
// time).
export interface MentionOption {
    readonly id: string;
    readonly basename: string;
    readonly parent: string;
    readonly kind: "file" | "folder";
}

export interface IndexEntry {
    readonly path: string;
    readonly kind: "file" | "folder";
}

// The `@token` that the cursor is currently inside. `start` points at the `@`,
// `end` is exclusive (one past the last token char). `query` is everything
// between `@` and `end`.
export interface ActiveMention {
    readonly start: number;
    readonly end: number;
    readonly query: string;
}
