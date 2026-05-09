# Ye — Providers

Ye talks to LLMs through a single `Provider` interface. **v1 + Phase 3 (Anthropic + OpenAI) shipped:** OpenRouter, Anthropic-direct (with prompt caching), and OpenAI (via Responses API). Adding a fourth provider is a single new folder under `src/providers/` and a registry entry — no other code changes. **Web tools (WebFetch/WebSearch) shipped early** — originally Phase 6, pulled forward.

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
- **Anthropic:** hardcoded per-model lookup table (vendor doesn't expose a discovery endpoint). Lives in `src/providers/anthropic/models.ts`. Current values: 1M for opus 4.6/4.7 and sonnet 4.6 (the API exposes the 1M window on the same model ID; no beta header required as of 2026-03-13); 200K for haiku 4.5 (no 1M variant).
- **OpenAI:** hardcoded per-model lookup table. Lives in `src/providers/openai/models.ts`.
- **Fallback on any failure:** `128_000`. Logged but not surfaced to the user.

The pipeline calls `getContextSize` **once per session**, on first turn, and caches the result in `SessionState.contextWindow`. No per-turn refetch. **A `/provider` or `/model` switch refetches and updates the cache** — different providers report different windows for the same model, and Anthropic's table is per-model.

## Errors

`stream()`'s terminal `stop` event carries a structured `ProviderError` instead
of a free-form string. Defined in `src/providers/types.ts`:

```ts
type ProviderErrorKind =
  | "rate_limit"        // 429
  | "overloaded"        // Anthropic 529 / OpenRouter "overloaded"
  | "server"            // 5xx
  | "auth"              // 401 / 403
  | "bad_request"       // 400 — generic
  | "max_tokens_invalid" // 400 — max_tokens parameter rejected
  | "prompt_too_long"   // 400 — prompt exceeds context window
  | "network"           // fetch-level (DNS, TLS, connection refused)
  | "stream_error"      // mid-stream parse/disconnect
  | "unknown";

interface ProviderError {
  readonly kind: ProviderErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number;
}
```

Helpers live in `src/providers/errors.ts`: `classifyHttpError({status, body, fallbackMessage})`,
`networkError(msg)`, `streamError(msg)`, `classifyMidStreamError(msg)` (sniffs
mid-stream `error` chunks for known kinds), and `isRetryable(err)`.

The recovery layer in `src/pipeline/recovery.ts` consumes these — see
PIPELINE.md "Recovery (Phase 4 — shipped)". Branching on `err.kind` outside
the providers/recovery modules is fine; branching on `provider.id` is still
forbidden.

## Non-streaming fallback

`ProviderInput.stream` is an optional flag. Default `true`. When `false`, the
provider POSTs without `stream: true` in the body and synthesises ProviderEvents
from the single non-streamed JSON via `parseBatch()`. Both providers expose
this. The recovery layer flips this on the first stream_error retry — the
transport switch is treated as a free retry (no attempt-counter bump).

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

## Anthropic (Phase 3 — shipped)

- POST `https://api.anthropic.com/v1/messages`
- Auth: `x-api-key` header. `anthropic-version: 2023-06-01` (additive features, not a version bump).
- Native tool-use blocks. Distinct top-level `system` parameter (not a `system` message). Tools use `input_schema` (not `parameters`).
- Streaming: SSE with `event:` + `data:` framing. The shared `sseDataLines` iterator skips the `event:` line; the `data:` payload's `type` field is sufficient to dispatch.
- Stream events: `message_start` → `content_block_start` (text or tool_use) → `content_block_delta` (`text_delta` / `input_json_delta` / thinking deltas — last two ignored in v1) → `content_block_stop` → `message_delta` (carries `stop_reason`) → `message_stop`. Errors arrive as `event: error` mid-stream.
- Tool-use blocks accumulate `input_json_delta` chunks per content-block index and are emitted as `tool_call` events once `stop_reason: tool_use` is seen.
- **Prompt caching:** `capabilities.promptCache = true`. The adapter places a single `cache_control: { type: "ephemeral" }` marker on the system block — the system body is the largest stable prefix in any turn. Pipeline-side cache markers (memory blocks, tool defs) are a follow-up.
- **Opus 4.7 sharp edges (handled in `adapt.ts`):** `temperature` is rejected on `claude-opus-4-7*` and is dropped from the request. `top_p`/`top_k` are not currently emitted by Ye.
- **Message conversion:** Ye's canonical OpenAI-style messages → Anthropic shape. Adjacent `tool` results merge into a single `user` message with multiple `tool_result` blocks (Anthropic's required shape). Assistant turns with tool calls become content arrays of `[text?, tool_use, ...]`. `system` messages are pulled out and concatenated into the top-level `system` field.

## OpenAI (Phase 3 — shipped)

- POST `https://api.openai.com/v1/responses`
- Auth: `Authorization: Bearer ...` (OPENAI_API_KEY)
- **Responses API v1:** Uses explicit item types (`message`, `function_call`, `function_call_output`, `reasoning`). No server-side session stickiness in Ye (uses `store: false` + `previous_response_id` emulation via replaying items in `input`).
- **Strict Schema:** Recursive schema transformation in `adapt.ts` ensures `additionalProperties: false` and `required` arrays include every property at every level to satisfy OpenAI's pedantic validator.
- **Prompt caching:** `capabilities.promptCache = true` (automatic 90% discount on GPT-5 family).
- **Reasoning:** `reasoning.delta` events emitted for thought summaries. `reasoning.effort` configurable via `providerOptions.reasoningEffort`.
- **Tool calls:** Reconstructed from `response.output_item.added` + semantic argument deltas. Map `call_id` to Assistant tool calls and use `fc_` item prefixes in multi-turn history.

## Selection

`getProvider(config, id)` returns the implementation; `id` defaults to `config.defaultProvider`. The boot path uses the `defaultModel.provider` + `defaultModel.model` pair from config. **Mid-session switching** is wired through `/provider` and `/model` slash commands — App rebuilds the provider, refetches `getContextSize`, and writes `state.activeModel` so the pipeline picks up the new model on the next turn. Per-subagent provider override is still a Phase 5 concern.

### Model registry

`src/providers/models.ts` is the single source of truth for the user-facing model picker. Each entry is `{ provider, id, label }` — `id` is the provider-native model name passed to the API; `label` is what `/model` shows in the picker and the status bar. **No other file enumerates models.**

Current entries (full list lives in `src/providers/models.ts`):

| Provider | id | Label |
|---|---|---|
| openrouter | `~google/gemini-flash-latest` | Gemini Flash (latest) |
| openrouter | `google/gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview |
| openrouter | `deepseek/deepseek-v4-pro` | DeepSeek v4 Pro |
| openrouter | `anthropic/claude-opus-4.7` | Opus 4.7 (OpenRouter) |
| openrouter | `anthropic/claude-sonnet-4.6` | Sonnet 4.6 (OpenRouter) |
| openrouter | `anthropic/claude-haiku-4.5` | Haiku 4.5 (OpenRouter) |
| anthropic | `claude-opus-4-7` | Opus 4.7 |
| anthropic | `claude-sonnet-4-6` | Sonnet 4.6 |
| anthropic | `claude-haiku-4-5` | Haiku 4.5 |
| openai | `gpt-5.5-pro`, `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex` | GPT-5.5 / 5.4 / 5.3-codex |
| openai | `gpt-5.2-pro`, `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.1` | GPT-5.2 / 5.1 family |
| openai | `gpt-5-codex-mini`, `gpt-5`, `gpt-5-mini`, `codex-mini-latest` | GPT-5 family + codex-mini |
| openai | `gpt-4.1`, `gpt-4.1-mini` | GPT-4.1 / 4.1 Mini |

The first OpenRouter entry (`~google/gemini-flash-latest`) is also the configured `defaultModel`. `defaultModelFor(providerId)` returns the first entry for a provider — used by `/provider` to pick a sensible model when switching providers (don't carry a model across providers).

### Config: missing-provider auto-merge

`loader.ts` merges any provider entry present in `DEFAULT_CONFIG.providers` but missing from the user's on-disk config — at load time, in-memory only. The user's saved file is **not** rewritten. This means existing configs created before Anthropic existed automatically gain the Anthropic provider config without forcing a manual edit. Users who customize an existing entry keep their version verbatim.

## Files

```
src/providers/
├── index.ts            # registry: getProvider(), PROVIDER_IDS, isMissingKeyError, re-exports model registry
├── build.ts            # tryBuildProvider() — handles missing-key prompts and config persistence
├── models.ts           # cross-provider model registry (id, label) + defaultModelFor()
├── pricing.ts          # per-call USD cost estimation; consumed by status bar + usage.jsonl
├── errors.ts           # ProviderError taxonomy + classifyHttpError / isRetryable helpers
├── types.ts            # Provider, ProviderInput, ProviderEvent, Message, ToolDefinition, ProviderCapabilities
├── sse.ts              # generic SSE line-iteration helper (reused by all providers)
├── openrouter/
│   ├── index.ts        # Provider impl
│   ├── adapt.ts        # Ye Message[] + Tools → OpenAI-compatible body
│   └── stream.ts       # SSE chunk → ProviderEvent
├── anthropic/          # Phase 3 — shipped
│   ├── index.ts        # Provider impl, MissingAnthropicKeyError
│   ├── adapt.ts        # Ye Message[] → Anthropic body (system split, tool_use/tool_result blocks, cache marker)
│   ├── stream.ts       # event: + data: SSE → ProviderEvent
│   └── models.ts       # per-model context-size table + isOpus47() guard
└── openai/             # Phase 3 — shipped
    ├── index.ts        # Provider impl, MissingOpenAIKeyError
    ├── adapt.ts        # Ye Message[] → Responses API body (recursive strict schema, instruction split)
    ├── stream.ts       # semantic event SSE -> ProviderEvent (reasoning deltas, function_call item support)
    └── models.ts       # per-model context-size table
```

## Decisions made

- **Streaming via async iterables, not callbacks or RxJS.** Composes naturally with the pipeline's generator.
- **No SDKs.** Direct `fetch` for each provider. Keeps deps minimal, keeps adapter logic obvious, makes prompt-cache control explicit. Revisit only if a provider's protocol becomes too painful by hand.
- **Env var name lives in config, not in code.** A user can run multiple OpenRouter keys side by side by editing `apiKeyEnv` in `~/.ye/config.json`. (Already supported in the existing config schema.)
- **One canonical Message shape.** Adapters convert at the edges. Pipeline never sees vendor-shaped data.
- **`provider.id` checks are forbidden outside `src/providers/`.** Capability-flag based dispatch only. Convention; reviewed manually. Promote to ESLint when contributors join.
- **Default config is not redefined here.** Source of truth: `src/config/defaults.ts`. This doc references field names; it does not duplicate the values.
- **Single model registry.** `src/providers/models.ts` is the only place models are listed. `/model` reads from it; the status bar reads labels from it. Adding a model is one entry, no other code changes.
- **Loader merges missing default-provider entries in-memory, never rewrites user config.** Lets new providers (Anthropic, eventually OpenAI) appear in `/provider` without forcing migrations on existing users.

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
- [x] `anthropic/adapt.ts` — system param split out, content blocks, tool_use/tool_result blocks, adjacent-tool-result merge, drop `temperature` on Opus 4.7
- [x] `anthropic/stream.ts` — `event:` + `data:` SSE framing; `content_block_start/_delta/_stop` + `message_delta` + `error`; `input_json_delta` accumulator per content-block index
- [x] `anthropic/models.ts` — per-model context-size table + `isOpus47` guard
- [x] Prompt cache marker placed on the system block (single `cache_control: ephemeral` on the system body)
- [x] `capabilities.promptCache = true`
- [x] `MissingAnthropicKeyError` + `isMissingKeyError` discriminator surfaced from `providers/index.ts`
- [x] Default-provider auto-merge in `loader.ts` so existing user configs gain the Anthropic entry without manual edits
- [ ] Pipeline-side cache markers on additional static prefixes (notes hierarchy, tool defs) — follow-up
- [ ] Cache-hit assertion in conformance suite

### Phase 3 — OpenAI
- [x] `openai/adapt.ts` — Responses API format, recursive strict schema transformation, instruction split, handle reasoning effort
- [x] `openai/stream.ts` — Semantic SSE event parser, reasoning delta support, function_call item reconstruction
- [x] `openai/index.ts` — Provider implementation, missing key handling
- [x] `openai/models.ts` — Context size registry for GPT-4/5 families
- [x] Registered in `PROVIDER_IDS` and model registry

### Conformance suite (Phase 3 gate)
- [ ] Same prompt across all three: text-only round-trip
- [ ] Same prompt across all three: tool-call round-trip
- [ ] Streaming chunk count > 1 across all three
- [ ] Cache-hit assertion on Anthropic when an identical prompt repeats
- [ ] Capability flags match documented behavior (no false positives)
