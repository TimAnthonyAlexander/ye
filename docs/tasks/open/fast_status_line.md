# Fast status line — show tool action line before full args finish streaming

## Problem

When the model writes a large tool call (e.g. `Write` with a 2000-line file), Ye's stream
parsers buffer the entire tool call and emit `tool_call` only after `stopReason === "tool_use"`
at the very end of the stream. The UI shows nothing but streaming text until all args arrive.

Claude Code fires its action line (`**Write** · index.html` with a spinner) as soon as the
tool name is known — the Anthropic API's `content_block_start` event for `tool_use` blocks
carries the tool name before any `input_json_delta` fragments arrive. The args stream after,
and the action line fills in the path/command as fragments arrive.

## Design

Add a new ProviderEvent `tool_call.starting { id, name }` emitted as soon as the tool name is
known from the stream. The pipeline forwards this as `model.toolCall.starting`. The UI creates
a ToolCallEntry with status "running" and just the tool name, rendered with a spinner.
The existing `tool_call` / `model.toolCall` event still fires at stream end with full args —
the UI updates the entry with args (path, command, pattern) and the pipeline executes it.

Event flow with this change:

```
provider: text.delta         → pipeline: model.text          → UI: streams text
provider: tool_call.starting → pipeline: model.toolCall.starting → UI: shows "⟳ Write" spinner
provider: text.delta         → pipeline: model.text          → UI: (ignored — tool already active)
provider: tool_call          → pipeline: model.toolCall      → UI: fills in "⟳ Write · index.html"
                                                                  pipeline: queues tool for execution
```

## New types

### `src/providers/types.ts` — ProviderEvent

Add after `tool_call`:

```
| {
      readonly type: "tool_call.starting";
      readonly id: string;
      readonly name: string;
  }
```

### `src/pipeline/events.ts` — Event

Add after `model.toolCall`:

```
| {
      readonly type: "model.toolCall.starting";
      readonly id: string;
      readonly name: string;
  }
```

## Per-provider changes

### Anthropic (`src/providers/anthropic/stream.ts`)

Emit in `content_block_start` handler (line ~184–189). When `cb.type === "tool_use"` and
`cb.id && cb.name`: yield `{ type: "tool_call.starting", id: cb.id, name: cb.name }`.

The existing `content_block_delta` / `input_json_delta` accumulation and end-of-stream
`tool_call` emission stays unchanged.

### OpenAI (`src/providers/openai/stream.ts`)

Emit in `response.output_item.added` handler (line ~145–155). When `item.type === "function_call"`:
yield `{ type: "tool_call.starting", id: item.call_id, name: item.name }`.

The item already has `id`, `call_id`, and `name` at this point — no partial accumulation needed.

Existing `response.function_call_arguments.delta` accumulation and `done`-based `tool_call`
emission stays unchanged.

- [x] OpenRouter

### OpenRouter (`src/providers/openrouter/stream.ts`)

Emit in the `delta.tool_calls` loop (line ~480–491). When a new tool call index is first
seen with a name:

```
if (tc.function?.name && !acc.name) {
    acc.name = tc.function.name;
    yield { type: "tool_call.starting", id: tc.id ?? `pending_${idx}`, name: tc.function.name };
}
```

The `id` field may or may not be present in the first delta. If `tc.id` is available, use it;
otherwise fall back to `pending_${index}` — the UI key needs to match the final `tool_call`
event's `id`, so when `tc.id` arrives on a later delta, the ToolCallAccumulator captures it
and the final `tool_call` uses it. The UI's `model.toolCall` handler overwrites the entry,
so the key must stay the same. **Edge case to verify**: do OpenRouter chunks always carry the
id in the first tool-call delta? If not, we need a stable synthetic id that survives until the
real id arrives.

### DeepSeek (`src/providers/deepseek/stream.ts`)

Same pattern as OpenRouter (OpenAI-compatible SSE). In the `delta.tool_calls` loop
(line ~229–239): when `tc.function?.name && !acc.name`, yield
`{ type: "tool_call.starting", id: tc.id ?? `pending_${idx}`, name: tc.function.name }`.

### Ollama (`src/providers/ollama/stream.ts`)

Ollama sends tool calls as complete objects on each chunk — name and args arrive together.
Unlike the other providers, there is no incremental arg accumulation.

Two options:

**A. Skip it.** For Ollama the tool call is already fast enough — no 2000-line payloads
stream into a local model. The benefit is negligible and the extra event adds complexity
for no user-visible improvement.

**B. Emit anyway for API consistency.** In `collectToolCalls` (line ~67–81), when a tool
call is first seen, yield `tool_call.starting`. The full `tool_call` fires immediately after
in the post-loop emission.

Recommend **A** — Ollama is a local model, the payloads are small, and the status line
already appears quickly.

## Pipeline dispatch (`src/pipeline/dispatch.ts`)

In `streamFromProvider` (line ~109–157), switch on the new `tool_call.starting` event type
and yield `{ type: "model.toolCall.starting", id: evt.id, name: evt.name }`.

## UI changes (`src/components/app.tsx`)

In the event handler loop (line ~1673), add a case for `model.toolCall.starting`:

Create a ToolCallEntry with `status: "running"` and just the name (no args). Use the same
pattern as the existing `model.toolCall` handler but without args:

```
const entry: ToolCallEntry = {
    id: evt.id,
    name: evt.name,
    args: {},
    status: "running",
};
setItems((prev) => [...prev, { kind: "toolCall", entry }]);
```

The existing `model.toolCall` handler stays unchanged — when it fires at stream end,
it overwrites the entry with full args via the same id.

**Edge case**: if `model.toolCall` fires without a preceding `model.toolCall.starting`
(batch mode, Ollama skipped, etc.), the existing handler creates the entry from scratch
just as it does today — no regression.

## Transcript safety

Do not persist `tool_call.starting` / `model.toolCall.starting` to the JSONL transcript.
The event is a UI hint only. Add a filter in `transcriptable()` in `src/pipeline/events.ts`
or filter it out in `queryLoop` where events are appended to session. The replay path
should never see a `model.toolCall.starting` — it would create a phantom entry with no
corresponding `tool.end`.

## Verification

- Start Ye, prompt: "write a 2000-line HTML file". During the model's generation,
  the status line should appear immediately with "**Write** · index.html" and a spinner,
  before the 2000 lines finish streaming.
- Test with Anthropic, OpenRouter, DeepSeek, and OpenAI providers.
- Test a tool call that arrives without args (empty `{}`) — the action line should show
  just the tool name with a spinner, then add args once they arrive.
- Test batch (non-streaming) mode — `model.toolCall` still fires as a single event,
  creating the entry with args. No `model.toolCall.starting` is emitted, so the UI
  should not regress.
- Verify session replay does not emit phantom entries.