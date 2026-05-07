// A file the user can reference via `@`. `id` is the project-relative path
// (forward-slashed, no leading `./`) — that's what gets inserted into the prompt.
export interface MentionOption {
    readonly id: string;
    readonly basename: string;
    readonly parent: string;
}

// The `@token` that the cursor is currently inside. `start` points at the `@`,
// `end` is exclusive (one past the last token char). `query` is everything
// between `@` and `end`.
export interface ActiveMention {
    readonly start: number;
    readonly end: number;
    readonly query: string;
}
