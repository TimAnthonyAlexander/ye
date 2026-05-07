export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCallRequest {
    readonly id: string;
    readonly type: "function";
    readonly function: {
        readonly name: string;
        readonly arguments: string;
    };
}

export interface Message {
    readonly role: Role;
    readonly content: string | null;
    readonly tool_calls?: readonly ToolCallRequest[];
    readonly tool_call_id?: string;
    readonly name?: string;
}

export interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly parameters: object;
}

export interface ProviderInput {
    readonly model: string;
    readonly messages: readonly Message[];
    readonly tools?: readonly ToolDefinition[];
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly signal?: AbortSignal;
    readonly providerOptions?: Readonly<Record<string, unknown>>;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error" | "abort";

export type ProviderEvent =
    | { readonly type: "text.delta"; readonly text: string }
    | {
          readonly type: "tool_call";
          readonly id: string;
          readonly name: string;
          readonly args: unknown;
      }
    | { readonly type: "stop"; readonly reason: StopReason; readonly error?: string };

export interface ProviderCapabilities {
    readonly promptCache: boolean;
    readonly toolUse: boolean;
    readonly vision: boolean;
    // True when the provider exposes server-side built-in tools (e.g.
    // Anthropic's web_search_20250305). Tools may opt in via
    // providerOptions.builtinTools.
    readonly serverSideWebSearch: boolean;
}

export interface Provider {
    readonly id: string;
    readonly capabilities: ProviderCapabilities;
    stream(input: ProviderInput): AsyncIterable<ProviderEvent>;
    countTokens?(messages: readonly Message[]): Promise<number>;
    getContextSize(model: string): Promise<number>;
}
