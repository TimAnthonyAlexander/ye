import type { PermissionMode } from "../config/index.ts";

export type SlashCommandResult =
    | { readonly kind: "ok" }
    | { readonly kind: "error"; readonly message: string };

export interface PickerOption {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

export interface PickerPayload {
    readonly title: string;
    readonly options: readonly PickerOption[];
    readonly initialId?: string;
}

export interface SlashCommandContext {
    readonly cwd: string;
    readonly projectRoot: string;
    readonly projectId: string;
    readonly mode: PermissionMode;
    readonly providerId: string;
    readonly model: string;
    setMode(next: PermissionMode): void;
    setProvider(next: string): Promise<void>;
    setModel(next: string): Promise<void>;
    clearChat(): Promise<void>;
    exitApp(): void;
    addSystemMessage(text: string): void;
    // Returns the most recent assistant text in the active session history,
    // or null if the conversation has no assistant text yet. Scans from the
    // tail and skips assistant turns that are tool-call-only (no text body).
    getLastAssistantText(): string | null;
    // Open the interactive picker. Resolves with the chosen option's `id`,
    // or `null` if the user dismissed (Esc).
    pick(payload: PickerPayload): Promise<string | null>;
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
