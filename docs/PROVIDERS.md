# Ye — Providers

Ye talks to LLMs through a single `Provider` interface. v1 implements one — OpenRouter (OpenAI-compatible chat completions). Anthropic-direct and OpenAI come in Phase 3. Adding a fourth provider is a single new folder under `src/providers/` and a registry entry — no other code changes.

## The interface

```ts
interface Provider {
  id: string;                              // "openrouter" | "anthropic" | "openai"
  stream(input: ProviderInput): AsyncIterable<ProviderEvent>;
  countTokens?(messages: Message[]): Promise<number>;
  getContextSize(model: string): Promise<number>;   // tokens; falls back to 128_000 on failure
  capabilities: ProviderCapabilities;
}

interface ProviderInput {
  model: string;                           // e.g. "deepseek/deepseek-v4-pro"
  messages: Message[];                     // Ye's canonical shape
  tools: ToolDefinition[];                 // Ye's canonical shape
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>; // e.g. OpenRouter's provider.order
}

type ProviderEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "stop"; reason: StopReason; error?: string };

interface ProviderCapabilities {
  promptCache: boolean;                    // Anthropic: true; OpenAI/OpenRouter: false (conservative)
  toolUse: boolean;
  vision: boolean;
}
```

`Message` is Ye's own canonical shape, not vendor-specific. Each provider implements two adapters:

- **Outbound:** Ye `Message[]` + `ToolDefinition[]` → vendor request body.
- **Inbound:** vendor stream chunks → Ye `ProviderEvent`s.

**Tool-call format normalization happens in the provider, not in the pipeline.** This is the firewall against vendor drift.

## Context-window discovery

`getContextSize(model)` returns the model's max context window in tokens. Used by the pipeline's auto-compact shaper to compute the trigger threshold (`currentTokens / contextWindow >= config.compact.threshold`).

- **OpenRouter:** `GET https://openrouter.ai/api/v1/models` exposes `context_length` per model.
- **Anthropic:** hardcoded per-model lookup table (vendor doesn't expose a discovery endpoint).
- **OpenAI:** hardcoded per-model lookup table.
- **Fallback on any failure:** `128_000`. Logged but not surfaced to the user.

The pipeline calls `getContextSize` **once per session**, on first turn, and caches the result in `SessionState.contextWindow`. No per-turn refetch.

## Capabilities flag

The pipeline asks `provider.capabilities` before deciding to:
- set up prompt-cache markers (Anthropic),
- attach image content blocks (vision),
- expect structured tool-use blocks vs OpenAI-style `tool_calls` arrays.

New capabilities are added as boolean flags rather than `if (provider.id === ...)` branches. Branches on `provider.id` are forbidden outside the provider module itself.

## OpenRouter (Phase 1)

- POST `https://openrouter.ai/api/v1/chat/completions`
- Auth: `Authorization: Bearer ${env[config.providers.openrouter.apiKeyEnv]}`
- Streaming: SSE, `data: {json}` lines, `[DONE]` terminator.
- `provider.order` + `allow_fallbacks: false` from `defaultModel.providerOrder` / `defaultModel.allowFallbacks` in config.
- Tool-call format: OpenAI-compatible `tool_calls` array on assistant deltas.
- `capabilities.promptCache = false` (varies per upstream model; conservative default).

## Anthropic (Phase 3)

- POST `https://api.anthropic.com/v1/messages`
- Auth: `x-api-key` header.
- Native tool-use blocks. Distinct `system` parameter (not a `system` message).
- Prompt caching: `cache_control: { type: "ephemeral" }` markers placed at the system prompt's static/dynamic boundary. `capabilities.promptCache = true`.
- Streaming: SSE with `event:` + `data:` framing.

## OpenAI (Phase 3)

- POST `https://api.openai.com/v1/chat/completions`
- Auth: `Authorization: Bearer ...`
- Tool calls = OpenAI standard (same shape as OpenRouter; the SSE adapter may share code).

## Selection

`getProvider(id)` returns the implementation; `id` defaults to `config.defaultProvider`. v1 uses the `defaultModel.provider` + `defaultModel.model` pair from config. Per-message provider override is a Phase 3 concern (e.g., a `Plan` subagent could prefer Sonnet via Anthropic even if the parent is on OpenRouter).

## Files

```
src/providers/
├── index.ts            # registry: getProvider(id), listProviders()
├── types.ts            # Provider, ProviderInput, ProviderEvent, Message, ToolDefinition, ProviderCapabilities
├── sse.ts              # generic SSE line-iteration helper (reused by all providers)
├── openrouter/
│   ├── index.ts        # Provider impl
│   ├── adapt.ts        # Ye Message[] + Tools → OpenAI-compatible body
│   └── stream.ts       # SSE chunk → ProviderEvent
├── anthropic/          # Phase 3
└── openai/             # Phase 3
```

## Decisions made

- **Streaming via async iterables, not callbacks or RxJS.** Composes naturally with the pipeline's generator.
- **No SDKs.** Direct `fetch` for each provider. Keeps deps minimal, keeps adapter logic obvious, makes prompt-cache control explicit. Revisit only if a provider's protocol becomes too painful by hand.
- **Env var name lives in config, not in code.** A user can run multiple OpenRouter keys side by side by editing `apiKeyEnv` in `~/.ye/config.json`. (Already supported in the existing config schema.)
- **One canonical Message shape.** Adapters convert at the edges. Pipeline never sees vendor-shaped data.
- **`provider.id` checks are forbidden outside `src/providers/`.** Capability-flag based dispatch only. Convention; reviewed manually. Promote to ESLint when contributors join.
- **Default config is not redefined here.** Source of truth: `src/config/defaults.ts`. This doc references field names; it does not duplicate the values.

## Checklist

### Phase 1 — OpenRouter
- [x] `types.ts` — Provider, ProviderInput, ProviderEvent, ProviderCapabilities, Message, ToolDefinition
- [x] `sse.ts` — generic SSE line iterator from a Response body
- [x] `index.ts` — `getProvider(id)` registry; reads `id` default from `config.defaultProvider`
- [x] OpenRouter `adapt.ts` — Ye Message[] + Tools → OpenAI-compatible body; passes `provider.order` + `allow_fallbacks` from `providerOptions`
- [x] OpenRouter `stream.ts` — SSE → `text.delta` / `tool_call` / `stop`; handles incremental tool-call argument streaming (chunks merge by `id`)
- [x] OpenRouter `index.ts` — `stream()` posts, returns async iterable
- [x] OpenRouter `getContextSize(model)` — `GET /models`, parse `context_length`; fallback to 128_000 on any failure
- [x] Reads API key from env var named in `config.providers.openrouter.apiKeyEnv`
- [x] Surfaces a clean error if the env var is missing (no silent failure)
- [x] Smoke test: a real call returns at least one `text.delta` and a `stop`
- [x] Smoke test: a tool-using prompt produces a `tool_call` event with parseable args

### Phase 3 — Anthropic
- [ ] `anthropic/adapt.ts` — system param split out, content blocks, tool_use blocks
- [ ] `anthropic/stream.ts` — `event:` + `data:` SSE framing
- [ ] Prompt cache markers placed at the system prompt's static/dynamic boundary
- [ ] `capabilities.promptCache = true`; pipeline reads it and inserts markers
- [ ] Cache-hit assertion in conformance suite

### Phase 3 — OpenAI
- [ ] `openai/adapt.ts` (largely shared with OpenRouter; if a small shared helper has zero abstraction tax, extract; otherwise duplicate the ~30 LOC)
- [ ] `openai/stream.ts`

### Conformance suite (Phase 3 gate)
- [ ] Same prompt across all three: text-only round-trip
- [ ] Same prompt across all three: tool-call round-trip
- [ ] Streaming chunk count > 1 across all three
- [ ] Cache-hit assertion on Anthropic when an identical prompt repeats
- [ ] Capability flags match documented behavior (no false positives)
