import type { PermissionMode } from "../config/index.ts";

export type SlashCommandResult =
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly message: string };

export interface SlashCommandContext {
  readonly cwd: string;
  readonly projectRoot: string;
  readonly projectId: string;
  readonly mode: PermissionMode;
  setMode(next: PermissionMode): void;
  clearChat(): Promise<void>;
  exitApp(): void;
  addSystemMessage(text: string): void;
}

export interface SlashCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly usage?: string;
  execute(args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> | SlashCommandResult;
}
