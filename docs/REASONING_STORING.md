**1. Anthropic direct (Messages API)**

Cache prefixes hash in fixed order: tools → system → messages. Up to 4 explicit `cache_control` breakpoints per request. Automatic mode places a single `cache_control` at the top level of the request body and the system applies the cache breakpoint to the last cacheable block, advancing it forward as conversations grow. Forward sequential checking: when you add a `cache_control` breakpoint, the system automatically checks for cache hits at all previous content block boundaries up to approximately 20 blocks before your explicit breakpoint, and uses the longest matching prefix. So one well-placed breakpoint typically does the job.

Pricing and TTL: cache writes cost 1.25x base input price, reads cost 0.1x base; minimum cacheable length is 1,024 tokens for Sonnet and 4,096 tokens for Opus and Haiku 4.5; default TTL is 5 minutes refreshed on each hit, 1-hour TTL is available at 2x base input price.

Thinking-block interaction:

- Thinking blocks cannot be marked with `cache_control` directly, but they CAN be cached alongside other content when they appear in previous assistant turns. When cached this way, they DO count as input tokens when read from cache.
- Thinking changes (enabling/disabling or budget changes) invalidate previously cached prompt prefixes with messages content. System+tools cache survives.
- During tool use, pass signed thinking blocks back unchanged or you break signature verification.

Per-model thinking preservation: thinking blocks from prior assistant turns kept in context: only the last turn on earlier Opus/Sonnet models and all Haiku models; all turns by default on Opus 4.5+ and Sonnet 4.6+. Opus 4.7 ships with `thinking.display` defaulting to "omitted" — signature still round-trips, visible thinking is empty.

Recommended setup for Ye on Anthropic direct:

Use explicit per-block `cache_control`, not top-level automatic. Top-level auto places the breakpoint on the last block, which on a fresh user turn is your new dynamic user message — meaning the cache breakpoint sits on the most volatile content and the next request gets nothing back. Lay out three breakpoints, hold one in reserve:

1. End of `tools` array (changes rarely; on tool schema update)
2. End of `system` prompt (changes rarely; on prompt revision)
3. Floating breakpoint on the last assistant message of the prior turn (advances each turn)
4. Reserved: hot-loaded context the user just attached (large file, codebase chunk) — separate breakpoint so it survives independent of conversation churn

Thinking blocks: always round-trip unchanged. The server filters per model — don't strip client-side or you break tool-use signatures. Don't toggle thinking budget mid-session; that invalidates message cache. If a user changes thinking effort, treat it as a session boundary internally.

Use 1-hour TTL (`"ttl": "1h"`) for coding-assistant sessions where users walk away for ~10 minutes. The 2x write cost pays back at the third request within the hour.

Verification: log `cache_creation_input_tokens` and `cache_read_input_tokens` from `usage`. Zero reads after turn 2 means a non-deterministic prefix — most often a timestamp injected into system prompt, or message array reordering.

For thinking survival: round-trip unchanged → Opus 4.5+/Sonnet 4.6+ keeps everything, older models keep just last turn (server-side, not your concern), Opus 4.7 keeps signature for the model but hides text from your UI unless you explicitly opt into a different `display` value.

---

**2. OpenAI direct (Responses API)**

No `cache_control` parameter exists — caching is implicit. Caching activates automatically for prompts longer than 1024 tokens, with cache hits occurring in increments of 128 tokens. Reads at 0.25x or 0.50x input price depending on model. In-memory TTL is typically 5-10 minutes of inactivity, up to one hour during off-peak periods. To configure prompt cache retention policy, set the `prompt_cache_retention` parameter on `Responses.create` requests; in-memory retention is available for all models except gpt-5.5, gpt-5.5-pro, and all future models. Extended retention adds up to 24h on supported models.

`prompt_cache_key`: each machine handles about ~15 RPM for a given prefix; if you use the same key on too many requests, requests overflow to multiple machines and you start the cache anew on each one. Routing is load-balanced — `prompt_cache_key` increases the chance similar prompts hit the same server but does not guarantee stickiness. Use it at session granularity, not globally and not per-request.

Reasoning interaction is the big differentiator versus Chat Completions:

OpenAI's internal benchmarks show 40-80% better cache utilization on the Responses API versus Chat Completions, because the raw chain of thought tokens get persisted in the Responses API between turns via `previous_response_id` (or encrypted reasoning items if you're stateless).

Two modes for reasoning preservation:

**Stateful (default, non-ZDR):** Pass `previous_response_id` from the prior call. Server holds reasoning items keyed by response ID. Simplest path; nothing for the client to round-trip.

**Stateless (`store=false` or ZDR):** Add `["reasoning.encrypted_content"]` to the include field in your API call. The API returns an encrypted version of the reasoning tokens, which you can pass back in future requests just like regular reasoning items. For ZDR organizations, OpenAI enforces `store=false` automatically. When a request includes `encrypted_content`, it is decrypted in-memory (never written to disk), used for generating the next response, and then securely discarded.

Critical caveat: encrypted content items (like `rs_...` reasoning items) can only be decrypted by the API key that created them. Load-balancing Responses API across deployments with different API keys breaks decryption with `invalid_encrypted_content` errors.

If reasoning items are missing on turn N+1: the API call cannot achieve a full cache hit because those reasoning items are missing from the prompt. However, including them is harmless — the API will simply discard any reasoning items that aren't relevant for the current turn.

Phase field for long agentic flows on GPT-5.5/5.4: use `phase: "commentary"` for intermediate assistant updates such as preambles before tool calls, and `phase: "final_answer"` for the completed answer. Don't add phase to user messages. Without it, model can early-stop on long tool chains.

Recommended setup for Ye on OpenAI Responses:

Default path: stateful mode with `previous_response_id` chaining. Store the response ID per Ye conversation in your session record, alongside your own message history. Each new turn passes `previous_response_id` from the last response. Reasoning is server-side, you don't manage it client-side.

ZDR path: switch to `store=false` + `include: ["reasoning.encrypted_content"]`. Extract reasoning items from each response (they have `id`, `encrypted_content`, optional `summary`). On next call, include them in the `input` array as items in their original position relative to user/assistant messages. Don't reorder, don't drop. Pin all requests for one conversation to the same API key — encrypted_content decryption is key-scoped.

`prompt_cache_key` = Ye conversation ID. One key per session. Don't reuse across sessions, don't make it globally constant.

`prompt_cache_retention="extended"` on supported models. For Ye coding assistants where sessions span hours, this is the difference between cache hits and full re-prefill.

Static-first, dynamic-last is non-negotiable. Azure OpenAI's prompt caching is prefix-based and instance-local; a large, static system prompt does not guarantee high cache hits on its own. If you inject the current date, session ID, or user context into the system message, every turn cache-misses at byte 0. Move that to the user message.

GPT-5.5/5.4: set the `phase` field on assistant messages.

For thinking survival: stateful gets it for free. Stateless gets it via `encrypted_content` round-trip. Both work.

---

**3. OpenRouter**

Caching is per-underlying-provider. Per route:

- Anthropic via OpenRouter: full `cache_control` support both top-level automatic and explicit per-block. Top-level automatic is only supported when requests are routed to the Anthropic provider directly — Amazon Bedrock and Google Vertex AI do not support top-level `cache_control`. Explicit per-block `cache_control` breakpoints work across all Anthropic-compatible providers including Bedrock and Vertex.
- OpenAI via OpenRouter: implicit, automatic, no markers. Same 1024 minimum, 0.25x reads.
- DeepSeek via OpenRouter: prompt caching is automated and does not require any additional configuration. DeepSeek cache construction is best-effort and can take a few seconds. An immediate follow-up may still show `cached_tokens: 0`; verify with a repeated same-prefix request after a short delay and use `usage.prompt_tokens_details.cached_tokens` as the cache-hit signal.
- Gemini 2.5 Pro and 2.5 Flash support implicit caching with no manual setup or `cache_control` breakpoints required, no cache write or storage costs, cached tokens charged at 0.25x the original input cost, TTL 3-5 minutes on average. Minimum 1024 tokens for Gemini 2.5 Flash, 4096 tokens for Gemini 2.5 Pro.
- Alibaba prompt caching (DeepSeek-v3.2, Qwen3-Max, etc.) requires explicit `cache_control: { "type": "ephemeral" }` breakpoints, Anthropic-style. 5-minute TTL.
- Gemini caching via OpenRouter with explicit `cache_control` only uses the last breakpoint; multiple breakpoints are tolerated for Anthropic compatibility but only the final one is applied for Gemini.

Sticky routing: after a request that uses prompt caching, OpenRouter remembers which provider served your request and routes subsequent requests for the same model to the same provider, keeping your cache warm. Sticky routing only activates when the provider's cache read pricing is cheaper than regular prompt pricing. Sticky routing is not used when you specify a manual provider order via `provider.order` — in that case, your explicit ordering takes priority.

Reasoning preservation. OpenRouter's `reasoning_details` is the canonical normalized format. All reasoning detail objects share `id`, `format`, and `index` fields. The `format` field has values: `unknown`, `openai-responses-v1`, `azure-openai-responses-v1`, `xai-responses-v1`, `anthropic-claude-v1`, `google-gemini-v1`. Three reasoning detail types: `reasoning.summary` for high-level summary, `reasoning.encrypted` for encrypted/redacted data with a `data` field, and `reasoning.text` for raw text with optional `signature` verification.

Preserving reasoning is supported by all OpenAI reasoning models (o1, o3, GPT-5+), all Anthropic reasoning models (Claude 3.7+), all Gemini reasoning, all xAI reasoning, plus Qwen3.5+, MiniMax M2+, Kimi K2 Thinking+, Nemotron 3 Nano+, INTELLECT-3, MiMo-V2-Flash+, GLM 4.5+. Note: Z.ai "preserved thinking" mode is currently not supported.

When providing `reasoning_details` blocks, the entire sequence of consecutive reasoning blocks must match the outputs generated by the model during the original request; you cannot rearrange or modify the sequence of these blocks.

The `:thinking` variant is no longer supported for Anthropic models on OpenRouter — use the `reasoning` parameter (`reasoning.effort` or `reasoning.max_tokens`) instead.

Recommended setup for Ye on OpenRouter:

Always use `reasoning_details` for preservation. The `reasoning` string alias loses signatures and encrypted blobs. Pass `reasoning_details` back attached to the assistant message in the next request, untouched. Order matters — don't dedupe, don't sort.

For Anthropic models via OpenRouter, set explicit `cache_control` breakpoints in the same positions you'd use directly with Anthropic (per the layout in section 1). Don't use top-level automatic if you allow Bedrock/Vertex failover — those endpoints will be excluded. Per-block works everywhere.

For OpenAI/DeepSeek/Gemini/Grok via OpenRouter: do nothing for caching. Implicit handles it. Static-first dynamic-last still applies — same byte-exact prefix rules.

For Gemini via OpenRouter with explicit caching, place exactly one `cache_control` at the end of static content. Extras are tolerated but only the last one matters.

For DeepSeek V4 Pro via OpenRouter (your test case): set `reasoning: { effort: "high" }` or `{ max_tokens: N }`, capture `reasoning_details` from each response, attach unchanged to every assistant message in subsequent requests. V4 Pro is consistent-required: every assistant message in the history needs `reasoning_details` once thinking is on, or you get HTTP 400. If you do this right, the prefix is stable, DeepSeek's implicit caching kicks in after a brief delay (seconds, per their best-effort behavior), and the model carries reasoning across turns.

For DeepSeek R1 via OpenRouter: opposite. Strip `reasoning_details` from the assistant message before send. R1 rejects reasoning_content in input.

Don't pin `provider.order` unless you have a hard requirement. It disables sticky routing, which is what keeps OpenAI/DeepSeek/Gemini caches warm across calls.

On model switch within OpenRouter (`anthropic/claude-sonnet-4.5` → `openai/gpt-5.5`): strip `reasoning_details` from history before send. The `format` field is provider-specific — Anthropic-format signatures won't validate against an OpenAI request, encrypted blobs from one provider can't decrypt at another. Visible content (text, tool_calls, tool_results) translates fine; only reasoning needs to go.

Cache verification per route: usage shapes differ. Anthropic returns `cache_read_input_tokens`. OpenAI/DeepSeek return `prompt_tokens_details.cached_tokens`. Build a per-route extractor.

For thinking survival: round-trip `reasoning_details` unchanged. Per-model preservation rules apply on the underlying provider; OpenRouter doesn't override them.



----

**Gemini (3, 3.1, 3 Flash, 2.5).** Gemini 3 family has a hard requirement on `reasoning_details` whenever tool calls are involved. The error shape from real-world bug reports is unmistakable: "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance", surfaced via OpenRouter as "Gemini models require OpenRouter reasoning details to be preserved in each request" with HTTP 400. So Gemini 3 with tool calling is a hard `required` policy, same shape as V4 Pro. Without tools, OpenRouter's model pages still say "Reasoning Details must be preserved when using multi-turn tool calling" and "When continuing a conversation, preserve the complete reasoning_details when passing messages back to the model so it can continue reasoning from where it left off" — so non-tool turns degrade silently if you strip, but don't 400. Treat Gemini 3 as `required` for tool turns, `preserve` for plain turns.

Other Gemini specifics: Gemini 3 Pro can't disable thinking — thinking is always on, default thinking level is "high", you can only set "low" or "high"; Gemini 2.5 doesn't support thinkingLevel and uses thinkingBudget instead. OpenRouter passes `reasoning.max_tokens` through as `thinkingBudget` to Google's API; for Gemini 3, Google internally maps that budget to a `thinkingLevel`, so you don't get precise token control. For your effort policy: Gemini 3 supports only low/high (medium maps internally), Gemini 2.5 supports max_tokens budget.

**MiniMax M2 / M2.1 / M2.5 / M2.7.** Policy is `preserve` (recommended, not enforced). MiniMax is the most explicit of any provider about why: "In MiniMax-M2, interleaved CoT works most effectively when prior-round reasoning is preserved and fed back across turns. The model reasons between tool calls and carries forward plans, hypotheses, constraints, and intermediate conclusions — this accumulated state is the backbone of reliability. When prior state is dropped, cumulative understanding breaks down, state drift increases, self-correction weakens, and planning degrades — especially on long-horizon toolchains and run-and-fix loops." OpenRouter's M2/M2.5/M2.7 model pages all carry the line "To avoid degrading this model's performance, MiniMax highly recommends preserving reasoning between turns." No 400 if you strip, but quality silently degrades — and degrades worse on long agentic chains, which is exactly the Ye use case.

There's a known failure mode worth knowing: when a MiniMax M2.x assistant message has no tool calls (plain text turn), some clients concatenate the thinking content into the visible content string instead of preserving it as a separate reasoning field. This silently degrades performance: no error raised, model loses access to its prior reasoning state on non-tool turns; degradation scales with task complexity. Your serializer needs to keep the reasoning channel separate even on text-only turns.

So the matrix gets these additions: Gemini 3.x → `required` (treat like V4 Pro); Gemini 2.5 → `preserve`; MiniMax M2.x → `preserve`. All use `reasoning_details` round-trip, OpenRouter normalizes the format.

---

**1. Same-family rule.** Your rule is too permissive on the accept-to-accept side. Empirically, same-family-different-version switches break on Anthropic: "this first came up when I switched to Claude Opus 4.6 in the middle of a Zed agent thread that had started with Opus 4.5… messages.19.content.62: Invalid `signature` in `thinking` block". Both Opus, both preserve-policy, signature still invalid. Anthropic signatures are model-version-bound, not family-bound. OpenAI's `encrypted_content` is API-key-bound and likely also tied to the response that produced it; cross-version switches within OpenAI carry the same risk even if it's not as widely reported.

The cross-provider case is also worth flagging since `family` boundaries can be ambiguous: "Start a new session, send a few messages with GLM 4.7 or MiniMax 2.1, switch model to Opus 4.5 via Anthropic, send message → Invalid signature in thinking block". Reasoning blocks from one provider injected into another's request body fail signature/decryption checks. Different family is a clear strip; you have that.

The right default: **strip on any model_id change**, not family change. The marginal gain from preserving across same-family-different-version is small (one cache hit on the next turn) versus the failure mode (a cryptic 400 the user can't diagnose). Where you want preservation across model-id changes, do it as an explicit per-pair whitelist after testing each pair specifically. Two pairs likely safe to whitelist on day one: `deepseek-v4-pro ↔ deepseek-v4-flash` (both consistent_required, plaintext reasoning_content with the same wire shape) and OpenRouter routes for the same upstream model under different aliases. Everything else: strip on switch.

This also covers the "policy reject" case automatically: a switch into a reject-policy model strips because model_id changed.

**2. Default reasoning effort.** Fold it into reasoningPolicy.ts now. The reason is structural: per-model effort is per-model config, and you already have a per-(route, model) matrix. Splitting into two places creates drift — specifically the kind of drift where someone adds V5 Pro to the policy table but forgets to update the effort defaults file. Three additional fields per row cover what you need:

```
effort_default:           "high" | "medium" | "low" | null
effort_levels_supported:  string[]      // whitelist; reject others client-side
thinking_disable_supported: bool        // false on Gemini 3 Pro
```

Per-row values for what's in scope today: V4 Pro defaults effort:"high" (DeepSeek's docs note "The default effort is high for regular requests; for some complex agent requests (such as Claude Code, OpenCode), effort is automatically set to max. For compatibility, low and medium are mapped to high, and xhigh is mapped to max" — so for V4 Pro, only "high" and "max" actually do anything distinct), R1 same, Gemini 3 Pro defaults effort:"high", supports only ["low", "high"], cannot disable. Gemini 2.5 uses max_tokens budget instead. MiniMax M2.5: on OpenRouter with reasoning.effort set to high, M2 produces ~1,000 tokens of reasoning before the answer; behavior is stable, so default "high" is reasonable.

Folding it in is small (mechanical addition to the matrix and the serializer), and it keeps the next round simpler — that round becomes "add OpenAI Responses surface" not "add OpenAI Responses surface plus migrate effort config."

**3. /rewind serialization.** Handle now, in the same PR. The reasoning is asymmetric blast radius: if /resume works (rides on the JSONL replay path) but /rewind silently drops `reasoning_details`, the user-visible failure is "Ye broke after I rewound a turn" with a 400 from V4 Pro's consistent_required check — and the user has no way to map that error back to /rewind. With Gemini 3 in the matrix on the next round, /rewind also breaks tool-using Gemini 3 sessions the same way. Whereas if you fix it now alongside the V4 Pro work, the change is mechanical: the checkpoint serializer needs to preserve the same `reasoning_details` field that the JSONL serializer preserves, and you can write one test that verifies both paths produce identical assistant-message structures for a sample message.

The test worth adding: turn-checkpoint-roundtrip equality. Take a captured V4 Pro response, serialize it through /rewind's checkpoint writer, deserialize, and assert byte-equality with the JSONL replay form. If they diverge, /rewind is wrong. Same test will catch Gemini 3 thought_signature drops in the next round without modification.

So: strip-on-any-model-id-change (whitelist exceptions later), fold effort policy into the matrix this round, fix /rewind serialization in the same PR with one round-trip equality test that covers both /resume and /rewind paths.

---

## Ye implementation status

### Shipped

**Canonical form.** Captured reasoning lives on `Message.reasoning_details` (typed discriminated union: `reasoning.text` | `reasoning.encrypted` | `reasoning.summary`, with `id` / `format` / `index` per OpenRouter's normalized shape). Carried on assistant messages through `state.history`, persisted via `model.reasoningDetails` events in the session JSONL, re-attached on `/resume` and `/rewind` via the same replay path. Model-version changes strip via `stripAllReasoningDetails` in `switchModel` / `switchProvider`.

**OpenRouter route.** Stream parser accumulates `delta.reasoning_details[]` into the canonical form. Per-model policy table (`src/providers/openrouter/reasoningPolicy.ts`) determines whether to round-trip on input. Levels: `required` (consistency-enforced; drop-all if any assistant lacks them), `required-on-tool-turns` (Gemini 3 — required only when history carries tool calls), `preserve` (best-effort, no enforcement), `reject` (strip on input, e.g. DeepSeek R1).

**Native DeepSeek route.** New provider at `src/providers/deepseek/` talking to `api.deepseek.com/chat/completions`. Uses DeepSeek's `reasoning_content` wire field, not `reasoning_details`. Implements DeepSeek's two-regime rule: keep `reasoning_content` on assistants *at or after* the last user message (active tool-call loop, else upstream 400); strip from assistants *before* the last user message (closed prior turns, per DeepSeek's official "drop between turns" guidance). Source-of-truth on Ye's side is still `reasoning_details`; the adapter flattens the `reasoning.text` blocks to a string at wire time.

**Routing strategy command (`/routing`).** OpenRouter-only. Strategies:
- `cheapest` (default) → `provider.sort: "price"`
- `fastest` → `provider.sort: "throughput"`
- `latency` → `provider.sort: "latency"`
- `sticky` → captures the upstream from the first turn's SSE chunk-level `provider` field and pins subsequent same-model requests to it via `provider.order`. Pins live in `SessionState.pinnedUpstream` keyed by model id; cleared on `/model` and `/provider` switches.

Persisted to `config.defaultModel.routing`. Explicit `defaultModel.providerOrder` overrides routing.

### Empirical findings (DeepSeek V4 Pro via OpenRouter)

Token-count A/B + UUID-recall tests (`scripts/debug-reasoning-v5.ts`) against every upstream OpenRouter lists for `deepseek/deepseek-v4-pro`:

| Upstream | Context | Forwards `reasoning_content`? |
|---|---|---|
| DeepSeek (official) | 1M | ❌ stripped |
| GMICloud | 1M | ❌ stripped |
| AtlasCloud | 1M | ❌ stripped |
| Novita | 1M | ❌ stripped |
| SiliconFlow | 1M | ❌ stripped |
| DeepInfra | **66k** | ✅ forwards |

`reasoning_details` (OpenRouter's normalized array) is stripped on every V4 Pro upstream — DeepSeek isn't on OpenRouter's published "reasoning preservation supported" list. `reasoning_content` (DeepSeek-native string field) is also stripped on every upstream **except DeepInfra**, which has a 66k context window. No upstream gives both full 1M context AND reasoning preservation.

**Consequence:** Ye's policy for `deepseek/deepseek-v4-pro` via OpenRouter is `preserve` (best-effort, silently dropped by all upstreams except DeepInfra). The native DeepSeek provider is the canonical path for actual V4 Pro reasoning round-trip. The `sticky` routing strategy lets users pin to DeepInfra explicitly on OpenRouter if they prefer that route — at the cost of the 66k context cap.

### Smoke-test scripts (manual regression checks)

Living under `scripts/` — run on demand to verify external contracts haven't shifted:

- `debug-reasoning-v5.ts` — per-upstream `reasoning_content` forwarding matrix for V4 Pro on OpenRouter.
- `debug-reasoning-control.ts` — Anthropic-via-OpenRouter signature-validation A/B (verifies `reasoning_details` is forwarded for non-DeepSeek routes).
- `debug-reasoning-v3.ts` — UUID-recall test across field shapes (reasoning_content vs reasoning vs reasoning_details vs thinking).
- `debug-reasoning-v2.ts` — early end-to-end OpenRouter probe.
- `debug-reasoning.ts` — earliest probe; superseded.

Each writes a JSON report to `/tmp/ye-debug-reasoning-*` for offline inspection.

### Not yet implemented

- Anthropic-native `cache_control` breakpoints per section 1 of this doc (per-block placement, ttl="1h" for coding sessions).
- OpenAI Responses API reasoning preservation via `previous_response_id` (stateful) or `encrypted_content` (stateless / ZDR).
- Per-pair model-switch whitelist for safe cross-version preservation (e.g. `deepseek-v4-pro ↔ deepseek-v4-flash`).
