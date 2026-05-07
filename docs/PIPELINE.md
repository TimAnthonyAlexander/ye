# Ye — Pipeline

The pipeline is the spine of Ye. One full *turn* runs the 9-step pipeline. The *agent loop* is just turns repeated until the model responds without calling any tools (or another stop condition fires).

Steps 5–9 are the "agent loop" people talk about. Steps 1–4 set the table for it.

## A turn, end to end

1. **Settings resolution.** Load runtime settings: permission mode, model choice, allowed/denied tools, project paths, hooks (later). Pulled from `~/.ye/config.json`, merged with project-level overrides where present.
2. **State initialization.** Session id, transcript file handle, token counters, retry budget. Ephemeral; lives for the turn (a subset persists across turns within the session).
3. **Context assembly.** Gather the ordered context sources (see below). Returns a flat `messages[]` array ready for the model.
4. **Pre-model shapers.** Run sequentially, cheapest first, each fires only if needed. v1: trim-oldest only. Phase 4: Budget Reduction → Snip → Microcompact → Context Collapse → Auto-Compact.
5. **Model call.** Send messages + tool definitions to the active provider. Stream response.
6. **Tool dispatch.** Parse tool calls from the stream. Read-only tools (Phase 2) queue parallel; state-modifying tools queue sequential. v1: serialize all.
7. **Permission gate.** For each tool call: pre-filter (denied tools never reach here), evaluate deny-first rules, route through the active permission handler (interactive prompt in `default` mode, auto-allow in `acceptAll`).
8. **Tool execution.** Run approved tools. Errors return as tool results, not crashes.
9. **Stop condition check.** Exit if: model returned no tool calls (text done), max turns reached, context overflow, hook abort (Phase 5), explicit cancel. Otherwise loop back to step 3 with new tool results appended.

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

## Recovery (Phase 4)

- Max output token escalation, up to 3 retries per turn.
- Reactive compaction fires at most once per turn.
- Prompt-too-long: try Context Collapse → Auto-Compact → terminate with a clean error.
- Streaming fallback (drop to non-streaming).
- Fallback model switch.

v1 has none of this. v1's failure mode for an oversized prompt is "tell the user, exit cleanly". This is a known KISS choice; full recovery is a Phase 4 expansion.

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
  | { type: "turn.end"; stopReason: StopReason };
```

The permission prompt is the only event that *expects a response*. It's modeled as a request/response pair via a `respond(decision)` function attached to the event.

## Files

```
src/pipeline/
├── index.ts            # public API: queryLoop()
├── turn.ts             # one turn of the 9 steps
├── assemble.ts         # step 3: context assembly
├── shapers/            # step 4
│   ├── index.ts        # runs shapers in order
│   └── trimOldest.ts   # v1's only shaper
├── dispatch.ts         # step 6: parse + queue tool calls
├── stop.ts             # step 9: stop condition evaluation
├── events.ts           # event types
└── state.ts            # turn-local state types
```

The permission gate (step 7) is in `src/permissions/`. Tool execution (step 8) is in `src/tools/`. The pipeline calls into them; it doesn't own them.

## Decisions made

- **Async generator over event emitter.** Generators are linear, easy to test, easy to consume from React with `for await`. No subscription bookkeeping. Same pattern Claude Code uses.
- **One turn = one transcript flush.** Append at the end of step 9. If the process crashes mid-turn, the next session loses that turn but disk state stays consistent.
- **No retry loops without budgets.** Every retry path has an explicit max.
- **Steps are functions, not classes.** Each step is a pure-ish function that takes turn state and returns turn state (or yields events). Easier to test in isolation, easier to reorder later if needed.

## Checklist

### Phase 1 — MVP pipeline
- [ ] `events.ts` — `Event` and `StopReason` types
- [ ] `state.ts` — `TurnState`, `SessionState`
- [ ] `index.ts` — `queryLoop(input): AsyncGenerator<Event>` skeleton
- [ ] Step 1: settings resolution — read `~/.ye/config.json`, merge with project overrides if present
- [ ] Step 2: turn-local state (session id, transcript handle, retry budget = 0 for v1)
- [ ] Step 3: `assemble()` — system prompt + env + resolved notes file (via `memory/notesFile.ts`) + history
- [ ] Step 4: single shaper, `shapers/trimOldest.ts` — drops oldest non-system messages above a hard token cap
- [ ] Step 5: model call via active provider; emits `model.text` and `model.toolCall`
- [ ] Step 6: `dispatch.ts` — parse tool calls, serialize all (no parallelism in v1)
- [ ] Step 7: route through `permissions.decide()`; emit `permission.prompt` when needed
- [ ] Step 8: execute tool, emit `tool.start`/`tool.end`, append result to history
- [ ] Step 9: stop conditions — no-tool-calls, max-turns (default 50), explicit cancel
- [ ] Transcript flush at end of each turn (append-only JSONL via storage layer)
- [ ] Smoke test: a turn with one Read tool call completes and produces a parseable JSONL transcript

### Phase 2 — Subagents in the loop
- [ ] Step 6: classify read-only vs state-modifying via `Tool.annotations.readOnlyHint`; parallel-dispatch read-only
- [ ] Subagent dispatch path through the same `queryLoop` with isolated state and sidechain transcript
- [ ] Auto-memory injected in step 3
- [ ] CLAUDE.md hierarchy concatenated in step 3

### Phase 4 — Recovery & full compaction
- [ ] Add Snip, Microcompact, Context Collapse, Auto-Compact shapers (in that order, cheapest first)
- [ ] Token-budget escalation in step 5 with explicit retry budget (max 3)
- [ ] Prompt-too-long → Context Collapse → Auto-Compact → terminate path
- [ ] Streaming fallback to non-streaming on stream errors
- [ ] Fallback model switch on persistent provider errors
- [ ] Compact-boundary events on session JSONL (`headUuid`/`anchorUuid`/`tailUuid`)

### Phase 5 — Hooks
- [ ] PreToolUse hook in step 7 (may return `permissionDecision`)
- [ ] PostToolUse hook after step 8
- [ ] Stop hook before step 9 returns
