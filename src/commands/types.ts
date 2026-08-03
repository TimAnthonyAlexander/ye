import type { Config, PermissionMode, PermissionRule } from "../config/index.ts";
import type { ConfigEdit } from "../config/edit.ts";
import type { ConfigRow } from "../config/registry.ts";
import type { ManualCompactResult } from "../pipeline/shapers/manualCompact.ts";
import type { Message } from "../providers/index.ts";

export type SlashCommandResult =
    | { readonly kind: "ok" }
    | { readonly kind: "error"; readonly message: string };

export interface PickerOption {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    // "header" rows render as dimmed section dividers, are skipped by arrow
    // navigation, can't be selected with Enter, and vanish from the filtered
    // view when the user types a query.
    readonly kind?: "item" | "header";
}

export interface PickerPayload {
    readonly title: string;
    readonly options: readonly PickerOption[];
    readonly initialId?: string;
}

// Output that arrives over time (an install log). Lines are coalesced into
// chat messages as they arrive; `close` flushes whatever is left.
export interface OutputSink {
    write(line: string): void;
    close(): void;
}

export interface SlashCommandContext {
    readonly cwd: string;
    readonly projectRoot: string;
    readonly projectId: string;
    readonly sessionId: string;
    readonly mode: PermissionMode;
    readonly providerId: string;
    readonly model: string;
    readonly config: Config;
    readonly contextWindow: number;
    setMode(next: PermissionMode): void;
    setProvider(next: string): Promise<void>;
    setModel(next: string): Promise<void>;
    clearChat(): Promise<void>;
    // Open the resume picker and (if a session is chosen) replay it. Returns
    // true when a session was loaded, false when the user cancelled or there
    // are no sessions available.
    resume(): Promise<boolean>;
    // Open the rewind picker for the active session. On selection, restores
    // file state to before the chosen user prompt and truncates conversation
    // history. Returns true when a rewind was applied.
    rewind(): Promise<boolean>;
    exitApp(): void;
    addSystemMessage(text: string): void;
    // Open a sink for a long-running command's output.
    streamOutput(): OutputSink;
    // Send a synthetic user prompt to the model without surfacing it in the
    // chat UI. Used by commands like /init that want to drive the agent loop
    // without polluting the visible transcript with internal instructions.
    sendHiddenPrompt(prompt: string): void;
    // Returns the most recent assistant text in the active session history,
    // or null if the conversation has no assistant text yet. Scans from the
    // tail and skips assistant turns that are tool-call-only (no text body).
    getLastAssistantText(): string | null;
    // Builds a context snapshot from the live session and pushes a panel into
    // the chat. Returns false when the session isn't ready (no state yet).
    showContextPanel(): Promise<boolean>;
    // Open the interactive picker. Resolves with the chosen option's `id`,
    // or `null` if the user dismissed (Esc).
    pick(payload: PickerPayload): Promise<string | null>;
    // Open the settings editor. Resolves with the edits the user wants kept,
    // or `null` when they discarded (Ctrl+C).
    editConfig(rows: readonly ConfigRow[]): Promise<readonly ConfigEdit[] | null>;
    // Merge edits into the raw config file and adopt them for this session.
    saveConfigEdits(edits: readonly ConfigEdit[]): Promise<void>;
    // Live conversation history and the permission rules granted during this
    // session (config rules live on `config`).
    getHistory(): readonly Message[];
    getSessionRules(): readonly PermissionRule[];
    getBackgroundTaskCount(): number;
    // Summarize older history on demand. `focus` steers what the summary keeps;
    // empty string means no steer.
    compact(focus: string): Promise<ManualCompactResult>;
    // Ask a question the conversation never learns about: streams an answer to
    // the chat, then discards both sides. Nothing reaches history or the
    // session file.
    askAside(question: string): Promise<void>;
}

export interface SlashCommand {
    readonly name: string;
    readonly aliases?: readonly string[];
    readonly description: string;
    readonly usage?: string;
    execute(
        args: string,
        ctx: SlashCommandContext,
    ): Promise<SlashCommandResult> | SlashCommandResult;
}
