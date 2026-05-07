import type { PermissionMode, PermissionRule } from "../config/index.ts";

export type { PermissionMode, PermissionRule };

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export type Decision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly message: string }
  | { readonly kind: "prompt" };

export type PromptResponse = "allow_once" | "allow_session" | "deny";
