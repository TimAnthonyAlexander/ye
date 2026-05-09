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
    // When false, the provider performs a non-streaming POST and synthesizes
    // ProviderEvent emissions from the single response. Default true. Used by
    // the recovery layer's "streaming → batch" fallback after a stream_error.
    readonly stream?: boolean;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error" | "abort";

export type ProviderErrorKind =
    | "rate_limit" // 429
    | "overloaded" // provider-side capacity (Anthropic 529, OpenRouter "overloaded")
    | "server" // 5xx
    | "auth" // 401/403
    | "bad_request" // 400 — generic
    | "max_tokens_invalid" // 400 — maxTokens parameter rejected
    | "prompt_too_long" // 400 — prompt exceeds context window
    | "network" // fetch-level (DNS, connection refused, TLS)
    | "stream_error" // mid-stream parse/disconnect
    | "unknown";

export interface ProviderError {
    readonly kind: ProviderErrorKind;
    readonly message: string;
    // True when the recovery layer can usefully retry. False = surface to user.
    readonly retryable: boolean;
    // HTTP status when the error came from a response. Absent for network /
    // stream errors that never produced a response.
    readonly status?: number;
}

export interface ProviderUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheCreationTokens?: number;
    // Native USD cost when the provider reports it (OpenRouter `usage.cost`).
    // For Anthropic / OpenAI direct, left undefined here and computed from
    // the local pricing table at storage time.
    readonly costUsd?: number;
}

export type ProviderEvent =
    | { readonly type: "text.delta"; readonly text: string }
    | { readonly type: "reasoning.delta"; readonly text: string }
    | {
          readonly type: "tool_call";
          readonly id: string;
          readonly name: string;
          readonly args: unknown;
      }
    | { readonly type: "usage"; readonly usage: ProviderUsage }
    | { readonly type: "stop"; readonly reason: StopReason; readonly error?: ProviderError };

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
