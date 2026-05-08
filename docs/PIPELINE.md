# Ye — Pipeline

The pipeline is the spine of Ye. One full *turn* runs the 9-step pipeline. The *agent loop* is just turns repeated until the model responds without calling any tools (or another stop condition fires).

Steps 5–9 are the "agent loop" people talk about. Steps 1–4 set the table for it.

## A turn, end to end

1. **Settings resolution.** Load runtime settings: permission mode, model choice, allowed/denied tools, project paths, hooks (later). Pulled from `~/.ye/config.json`, merged with project-level overrides where present.
2. **State initialization.** Session id, transcript file handle, token counters, retry budget. Ephemeral; lives for the turn (a subset persists across turns within the session).
3. **Context assembly.** Gather the ordered context sources (see below). Returns a flat `messages[]` array ready for the model.
4. **Pre-model shapers.** Run sequentially, cheapest first, each fires only if needed. **v1: one shaper, `autoCompact`** — fires when `currentTokens / contextWindow >= compact.threshold` (default 0.5, configurable in `~/.ye/config.json`). Phase 4: adds Budget Reduction → Snip → Microcompact → Context Collapse *before* Auto-Compact, so cheap shapers run first.
5. **Model call.** Send messages + tool definitions to the active provider on the active model. The model id is `state.activeModel ?? config.defaultModel.model` — `/model` and `/provider` mutate `state.activeModel` mid-session. Stream response.
6. **Tool dispatch.** Parse tool calls from the stream. Read-only tools (Phase 2) queue parallel; state-modifying tools queue sequential. v1: serialize all.
7. **Permission gate.** For each tool call: pre-filter (denied tools never reach here), evaluate deny-first rules, route through the active permission handler (interactive prompt in `default` mode, auto-allow in `acceptAll`).
8. **Tool execution.** Run approved tools. Errors return as tool results, not crashes.
9. **Stop condition check.** Exit if: model returned no tool calls (text done), max turns reached (`maxTurns.master` default 100; subagents use `maxTurns.subagent` default 25), context overflow, **PLAN-mode loop guard tripped** (two consecutive denials of the same tool in PLAN mode → terminate the turn with a "switch modes via Shift+Tab" message), hook abort (Phase 5), explicit cancel. Otherwise loop back to step 3 with new tool results appended.

## Context sources (assembly order)

```
system prompt
  → environment info (cwd, platform, date, model id)
    → notes file (CLAUDE.md or YE.md, resolved centrally)
      → path-scoped rules (Phase 2)
        → auto-memory (Phase 2)
          → tool metadata
            → conversation history
              → prior tool results
                → compact summaries (Phase 4)
```

Sources Ye resolves through the centralized resolvers (no duplicate logic): notes file (`memory/notesFile.ts`), project memory, global `MEMORY.md`. The pipeline does not re-decide which file to read.

## Step 4 detail — shaper chain

Shapers run in declared order from cheapest to most expensive; each checks its own trigger and returns `"skip"`, `"applied"` (mutated history; orchestrator re-assembles before the next shaper), or `"done"` (request now fits; chain stops). The orchestrator owns a mutable `RequestBudget` shapers can lower; the resolved `budget.maxTokens` is then passed to the provider.

Current chain (cheapest → most expensive):

1. **Budget Reduction** — no model call, no history mutation. Clamps `budget.maxTokens` to `min(initialMaxTokens, contextWindow - margin - promptTokens)`. If the clamp lowered the budget enough to fit, returns `"done"` and the chain stops. If even the floor (`compact.minReplyTokens`, default 1024) wouldn't fit, returns `"skip"` and lets prompt-shrinking shapers run.
2. **Snip** — no model call. Fires at `compact.snipThreshold` (default 0.35). Replaces the largest old `role:"tool"` results outside the protected tail (`compact.snipProtectedTail`, default 8) with a tiny `[snipped: stale tool result]` stub, preserving `tool_call_id` so providers don't reject orphaned pairs. Drops biggest first until projected tokens fall below `compact.snipFloor` (default 0.30) or `compact.snipMaxPerTurn` (default 10) is hit.
3. **Microcompact** — no model call. Fires at `compact.microcompactThreshold` (default 0.42). Truncates *all* eligible tool results outside the hot tail (`compact.microcompactHotTail`, default 6) whose content exceeds `compact.microcompactMinBytes` (default 1024). Stub is `[microcompacted: tool=<name>, id=<id>, size≈<orig>B]` — preserves the tool name (looked up via the assistant's prior `tool_calls`) and call id.
4. **Context Collapse** — one model call. Fires at `compact.collapseThreshold` (default 0.48). Mechanically identical to Auto-Compact but with a wider preserve-recent window (`compact.collapsePreserveRecent`, default 12) and a slightly lighter summary prompt (≤200 words). Uses the shared `summarize.ts` helper, which carries the boundary-pairing guard.
5. **Auto-Compact** — last-resort. Fires when `currentTokens / contextWindow >= config.compact.threshold` (default 0.5). Preserves only the last 4 messages. Same shared `summarize.ts` helper.

Each history-mutating shaper carries a one-shot `state.shapingFlags.<name>` flag, reset at turn start. The orchestrator caps total `"applied"` count at `MAX_SHAPER_APPLIED_PER_TURN = 4` per turn — belt-and-suspenders against the leaked-Claude-Code retry-loop bug. After the chain ends, a finalizer re-runs `clampBudget()` to take advantage of any space prompt-shrinking shapers freed.

Each `"applied"` emits a `shaper.applied` event (`name`, `tokensFreed`) — picked up by the UI for a one-line dim status and persisted to the session JSONL.

### Auto-compact logic

1. At step 4, compute `currentTokens` (sum of message token counts; estimate via `provider.countTokens?` if available, else heuristic).
2. Compare against `contextWindow`, which is cached in `SessionState` from a one-time `provider.getContextSize(model)` call at session start. Fallback when the call fails: 128K.
3. If `currentTokens / contextWindow >= config.compact.threshold` (default 0.5), run the auto-compact: a model-summary call that replaces older messages with a single summary message, preserving the system prompt and the most recent N turns intact.
4. Each turn fires the shaper at most once (the same anti-runaway-loop rule as Claude Code's reactive compaction).

> **Risk note (acknowledged):** 0.5 is aggressive — it triggers when half the window is empty. The threshold is config-driven so tuning costs nothing. Revisit after a week of real use.

## Recovery (Phase 4 — shipped)

`src/pipeline/recovery.ts` wraps the model call with a retry orchestrator. It
classifies provider errors via the `ProviderError` taxonomy (see PROVIDERS.md)
and applies one of five strategies:

| Strategy | Trigger | Action |
|---|---|---|
| Lower max_tokens | `max_tokens_invalid` | Halve `budget.maxTokens` (floor 1024); retry |
| Non-streaming | `stream_error`, first time | Re-call with `stream: false`; free retry (no attempt-count bump) |
| Force shaper | `prompt_too_long`, first time | `runSummarizeAndReplace(preserveRecent=4)`; re-assemble; retry |
| Fallback model | retry budget near-exhausted, `recovery.fallbackModel` set | Rebuild provider if needed, swap model; one shot |
| Backoff | rate_limit / overloaded / server / network | Exponential backoff (`backoffBaseMs * 2^attempt`, capped at `backoffMaxMs`); retry |

Hard rule: **retries only fire when no model content has streamed yet** in the
failed attempt. Once any text or tool call has been yielded, the result commits
as-is — replaying would duplicate output in the UI. This is the seam that lets
us run streaming retries safely without buffering deltas.

Retry budget defaults: `recovery.maxRetries: 3`, `backoffBaseMs: 500`,
`backoffMaxMs: 8000`. All configurable.

Recovery emits `recovery.retry` events for the UI: `{ attempt, kind, action,
waitMs? }`. The session JSONL captures them too.

> Direct lesson from the leaked Claude Code compaction bug: every retry path has an explicit budget. No silent infinite-retry loops.

## Streaming model

The pipeline is an `AsyncGenerator<Event>`. The UI consumes it. A future headless mode consumes the same stream and renders to stdout — that's the headless seam.

### Event shapes

```ts
type Event =
  | { type: "turn.start"; turnIndex: number }
  | { type: "model.text"; delta: string }
  | { type: "model.toolCall"; id: string; name: string; args: unknown }
  | { type: "permission.prompt"; toolCall: ToolCall }    // UI awaits, replies allow/deny
  | { type: "tool.start"; id: string; name: string }
  | { type: "tool.end"; id: string; result: ToolResult }
  | { type: "shaper.applied"; name: string; tokensFreed: number }  // step 4 mutation
  | { type: "recovery.retry"; attempt: number; kind: string; action: "lowered_max_tokens" | "non_streaming" | "force_shaper" | "fallback_model" | "backoff"; waitMs?: number }
  | { type: "turn.end"; stopReason: StopReason; error?: ProviderError };
```

The permission prompt is the only event that *expects a response*. It's modeled as a request/response pair via a `respond(decision)` function attached to the event.

## Files

```
src/pipeline/
├── index.ts                # public API: queryLoop()
├── turn.ts                 # one turn of the 9 steps
├── assemble.ts             # step 3: context assembly
├── shapers/                # step 4
│   ├── index.ts            # runs shapers in declared order; owns the reply-budget object; emits shaper.applied events
│   ├── types.ts            # Shaper interface + ShaperContext + RequestBudget
│   ├── tokens.ts           # estimateTokens() + estimateMessageTokens() — shared heuristic
│   ├── budgetReduction.ts  # clamps reply budget to fit window (cheapest); also exports clampBudget() finalizer
│   ├── snip.ts             # drops largest old tool results, replacing with stub
│   ├── microcompact.ts     # truncates all eligible old tool results to descriptor stubs
│   ├── contextCollapse.ts  # wider-window summarization (model call, lower threshold than autoCompact)
│   ├── summarize.ts        # shared summarize-and-replace helper + boundary-pairing guard
│   ├── toolCallLookup.ts   # findToolNameForCallId() — used by Microcompact's stubs
│   └── autoCompact.ts      # last-resort — threshold-triggered model summary
├── dispatch.ts             # step 6: parse + queue tool calls
├── stop.ts                 # step 9: stop condition evaluation
├── events.ts               # event types
└── state.ts                # turn-local state types
```

The permission gate (step 7) is in `src/permissions/`. Tool execution (step 8) is in `src/tools/`. The pipeline calls into them; it doesn't own them.

## Decisions made

- **Async generator over event emitter.** Generators are linear, easy to test, easy to consume from React with `for await`. No subscription bookkeeping. Same pattern Claude Code uses.
- **One turn = one transcript flush.** Append at the end of step 9. If the process crashes mid-turn, the next session loses that turn but disk state stays consistent.
- **No retry loops without budgets.** Every retry path has an explicit max.
- **Steps are functions, not classes.** Each step is a pure-ish function that takes turn state and returns turn state (or yields events). Easier to test in isolation, easier to reorder later if needed.
- **Context-window size is cached per session.** `provider.getContextSize(model)` runs once at session start; the result lives in `SessionState`. The auto-compact shaper reads from the cache, never re-fetches. Mid-session `/provider` or `/model` switches refetch and update the cache — different providers and models report different windows.
- **PLAN-mode loop guard at the pipeline layer, not the permission layer.** Tracking "two consecutive same-tool denials" is turn-state, so it lives next to the stop-condition check.

## Checklist

### Phase 1 — MVP pipeline
- [x] `events.ts` — `Event` and `StopReason` types (include `plan_loop_guard` reason)
- [x] `state.ts` — `TurnState`, `SessionState` (SessionState carries cached `contextWindow`, current `mode`, optional `activeModel` override for `/model`/`/provider`, recent denial trail for the PLAN-mode loop guard)
- [x] `index.ts` — `queryLoop(input): AsyncGenerator<Event>` skeleton
- [x] Step 1: settings resolution — read `~/.ye/config.json`, merge with project overrides if present
- [x] Step 2: turn-local state (session id, transcript handle, retry budget = 0 for v1); on first turn of a session, call `provider.getContextSize(model)` and cache the result
- [x] Step 3: `assemble()` — system prompt + env + resolved notes file (via `memory/notesFile.ts`) + history
- [x] Step 4: single shaper, `shapers/autoCompact.ts` — fires when `currentTokens / contextWindow >= config.compact.threshold` (default 0.5); at most once per turn
- [x] Step 5: model call via active provider; emits `model.text` and `model.toolCall`
- [x] Step 6: `dispatch.ts` — parse tool calls, serialize all (no parallelism in v1)
- [x] Step 7: route through `permissions.decide()`; emit `permission.prompt` when needed
- [x] Step 8: execute tool, emit `tool.start`/`tool.end`, append result to history
- [x] Step 9: stop conditions — no-tool-calls, max-turns (`maxTurns.master` default 100; `maxTurns.subagent` default 25), explicit cancel, PLAN-mode loop guard (two consecutive denials of the same tool in PLAN mode)
- [x] PLAN-mode denial trail tracked in `TurnState`; reset on mode flip
- [x] Transcript flush at end of each turn (append-only JSONL via storage layer)
- [x] Smoke test: a turn with one Read tool call completes and produces a parseable JSONL transcript — covered by pipeline state/stop/recovery tests
- [x] Smoke test: in PLAN mode, two Edit attempts in a row terminate the turn with the loop-guard reason — covered by stop.test.ts

### Phase 2 — Subagents in the loop
- [ ] Step 6: classify read-only vs state-modifying via `Tool.annotations.readOnlyHint`; parallel-dispatch read-only (annotations exist; parallel dispatch deferred — tools still serialize in v2)
- [x] Subagent dispatch path through the same `queryLoop` with isolated state and sidechain transcript
- [x] Auto-memory injected in step 3
- [x] CLAUDE.md hierarchy concatenated in step 3

### Phase 4 — Recovery & full compaction
- [x] Shaper-ordering scaffold: `Shaper` interface + `runShapers()` orchestrator with mutable `RequestBudget`; replaces the single direct `autoCompact()` call in `turn.ts`
- [x] **Budget Reduction** shaper — clamps reply `maxTokens` to fit the window before falling through to prompt-shrinking shapers; pipeline now plumbs `maxTokens` through to the provider
- [x] **Snip** shaper — drop large stale tool results (highest user-visible payoff per LOC)
- [x] **Microcompact** shaper — local truncation of old large tool results to descriptor stubs (Ye variant; no model call, no Anthropic `cache_edits` path)
- [x] **Context Collapse** shaper — model summarize with wider preserve-recent window than Auto-Compact, fires earlier
- [x] `runShapers` is an `AsyncGenerator<Event, RunShapersOutput>`; emits `shaper.applied` events as shapers fire; `MAX_SHAPER_APPLIED_PER_TURN = 4` orchestrator cap (belt-and-suspenders against the leaked-Claude-Code retry-loop bug)
- [x] Per-shaper one-shot `state.shapingFlags`; `clampBudget()` finalizer runs after the chain when any shaper applied, so prompt-shrinking results in a higher reply budget
- [x] Shared `summarize.ts` with boundary-pairing guard (prevents orphaned `tool_call_id` across the older/recent split — used by both `autoCompact` and `contextCollapse`)
- [x] Token-budget escalation in step 5 with explicit retry budget (default 3, configurable in `recovery.maxRetries`); `max_tokens_invalid` halves and retries
- [x] Prompt-too-long → forced summarize-and-replace → retry; surfaces typed error if shaper escalation can't free enough room
- [x] Streaming fallback to non-streaming on stream errors — `ProviderInput.stream` flag plumbed through OpenRouter and Anthropic; both providers now expose a `parseBatch()` non-stream code path
- [x] Fallback model switch on persistent provider errors — `recovery.fallbackModel` config; cross-provider fallback supported (recovery rebuilds via `getProvider`)
- [ ] Compact-boundary events on session JSONL (`headUuid`/`anchorUuid`/`tailUuid`) — Phase 4.5 (needs message UUIDs + read-time projection layer; Phase 4 shapers mutate `state.history` in place instead)
- [ ] Smart-staleness Snip (path-aware: drop a Read result on file X if a later operation supersedes it) — Phase 4.5; needs a `Tool → "what file did this affect?"` resolver
- [ ] LLM-summarization variant of Microcompact — Phase 4.5; gated behind a config flag, default off (current Microcompact is local-truncation-only to stay genuinely cheaper than Auto-Compact)

### Phase 5 — Hooks
- [x] PreToolUse hook in step 7 (may return `permissionDecision` — blocks tool with exit 2)
- [x] PostToolUse hook after step 8
- [x] Stop hook before step 9 returns
- [x] UserPromptSubmit hook (injects context into model-bound prompt)
- [x] SubagentStop hook (after subagent completes)
- [x] PreCompact hook (before compaction shapers run)
- [x] SessionStart hook (after provider + session are ready)
