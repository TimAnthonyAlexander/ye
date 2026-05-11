export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCallRequest {
    readonly id: string;
    readonly type: "function";
    readonly function: {
        readonly name: string;
        readonly arguments: string;
    };
}

// OpenRouter's normalized reasoning format. Three variants, all share id /
// format / index. Round-tripped verbatim on the next request; never edited,
// reordered, or deduped — signatures and encrypted blobs are bound to the
// exact sequence the model emitted.
export type ReasoningFormat =
    | "unknown"
    | "openai-responses-v1"
    | "azure-openai-responses-v1"
    | "xai-responses-v1"
    | "anthropic-claude-v1"
    | "google-gemini-v1";

interface ReasoningDetailBase {
    readonly id?: string;
    readonly format?: ReasoningFormat;
    readonly index?: number;
}

export type ReasoningDetail =
    | (ReasoningDetailBase & {
          readonly type: "reasoning.text";
          readonly text: string;
          readonly signature?: string;
      })
    | (ReasoningDetailBase & {
          readonly type: "reasoning.encrypted";
          readonly data: string;
      })
    | (ReasoningDetailBase & {
          readonly type: "reasoning.summary";
          readonly summary: string;
      });

export interface Message {
    readonly role: Role;
    readonly content: string | null;
    readonly tool_calls?: readonly ToolCallRequest[];
    readonly tool_call_id?: string;
    readonly name?: string;
    // Structured reasoning trace from a thinking-capable model. Present only on
    // assistant messages produced by such a model. Round-tripped on the next
    // request per the model's policy (see openrouter/reasoningPolicy.ts).
    readonly reasoning_details?: readonly ReasoningDetail[];
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
    // Stable string that pins requests with the same prefix to the same cache
    // shard. Without it, OpenAI's load balancer routes successive requests to
    // different shards, missing the cache on the first 2-3 requests of every
    // session. Set per "user" granularity per OpenAI's guidance — for ye that
    // is projectId, since the same project shares system prompt + CLAUDE.md +
    // tool list across sessions. Currently consumed only by the OpenAI
    // provider; other providers ignore it.
    readonly cacheKey?: string;
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
    // Upstream provider name when the route is multi-tenant (e.g. OpenRouter's
    // top-level `provider` field: "DeepSeek", "DeepInfra", "Novita", etc).
    // Captured for sticky routing — Ye pins to whatever upstream served the
    // first turn so subsequent turns hit the same one.
    readonly upstream?: string;
}

export type ProviderEvent =
    | { readonly type: "text.delta"; readonly text: string }
    | { readonly type: "reasoning.delta"; readonly text: string }
    | { readonly type: "reasoning.complete"; readonly details: readonly ReasoningDetail[] }
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
