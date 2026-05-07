# Ye — Tools

Tools are how the model affects the world. Each tool is a TypeScript module exporting a definition (name, JSON Schema for args, annotations) and an `execute` function.

## Conventions

- **One file per tool.** `src/tools/<name>/index.ts`. Bigger tools may grow a folder of helpers.
- **Annotations drive scheduling.** `readOnlyHint: true` lets the dispatcher (Phase 2) run a tool in parallel and lets the permission gate auto-allow it in `default` mode. Default is sequential and prompted.
- **Errors are results, not throws.** A tool that fails returns a `ToolResult` with `error`. The model sees it. The loop continues. Only programmer errors throw.
- **Args validated at the boundary.** A JSON Schema validator runs before `execute`. Bad args → `ToolResult` with `error`, no execution.
- **Path arguments are absolute.** Resolution to absolute happens once, in the tool, using the storage layer's helpers. Never re-resolve mid-execute.
- **No tool reads `~/.ye/config.json` directly.** Settings come in via `ctx`.

## Tool definition shape

```ts
interface Tool<Args, Result> {
  name: string;
  description: string;
  schema: JSONSchema;                 // for args
  annotations: {
    readOnlyHint?: boolean;
    destructive?: boolean;
  };
  execute: (args: Args, ctx: ToolContext) => Promise<ToolResult<Result>>;
}

interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  sessionId: string;
  turnState: TurnState;               // for invariants like Read-then-Edit
  log: (msg: string) => void;
}

type ToolResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: string };
```

## V1 tools (Phase 1)

Seven tools. Enough to be useful for daily work. No subagent stuff, no web, no MCP.

| Tool | readOnly | Notes |
|------|----------|-------|
| Read | yes | Default 2000-line slice; `offset` + `limit` supported. Absolute paths only. PDF/image support deferred to Phase 6. |
| Edit | no | Exact-string replace; requires prior Read of the same file in this turn. `replace_all` flag. |
| Write | no | Creates or overwrites. If the file exists, prior Read required. |
| Bash | no | Default 2-min timeout, max 10 min. **No sandbox in v1**; documented gap. `run_in_background` deferred. |
| Grep | yes | Wraps `rg`. Modes: `content`, `files_with_matches`, `count`. |
| Glob | yes | File pattern match. Returns paths sorted by mtime. |
| TodoWrite | no | States: `pending`, `in_progress`, `completed`. Exactly one `in_progress` at a time. In-memory in v1; flushes via session JSONL. |

### Notable design calls

- **Read-then-Edit invariant** is tracked in turn-local state, not on disk. Each subagent sees its own invariant.
- **Bash without sandbox in v1** is a documented limitation. Until Phase 5 adds sandboxing, `acceptAll` is genuinely "trust me". This is loud in the help text.
- **No PowerShell in v1** (Phase 6).
- **TodoWrite is in-memory.** Persists to the session JSONL via standard transcript flush. Survives resume in Phase 4.
- **Grep shells out to `rg`.** Documented dependency; install script checks for it. We do not implement a JS regex search — performance and correctness aren't worth re-deriving.
- **No `dangerouslyDisableSandbox` flag in v1.** It only makes sense once we have a sandbox to disable. Phase 5.

## Tool pool assembly

A single function — `assembleToolPool(settings, mode)` — returns the array of tool definitions to expose to the model this turn. Steps:

1. **Base enumeration** — all built-ins.
2. **Mode filtering** — drop tools the active permission mode forbids (e.g., `plan` mode in Phase 5 will drop Edit/Write/Bash).
3. **Deny-rule pre-filtering** — tools blanket-denied are removed before the model ever sees them.
4. **(Phase 7+) MCP integration.**
5. **Deduplication.**

This function is the single seam where new sources of tools get added (subagents in Phase 2, MCP in Phase 7+). No other code enumerates tools.

## Future tools (post-v1)

Listed by phase so the roadmap is in one place. Checkbox items live in the per-phase checklist below.

- **Phase 2:** `Task` (subagent), `TaskOutput`, `TaskStop`, `EnterPlanMode`, `ExitPlanMode`, `AskUserQuestion`.
- **Phase 5:** `Skill`, `EnterWorktree`, `ExitWorktree`, `NotebookEdit`.
- **Phase 6:** `WebFetch`, `WebSearch`, `PowerShell`, `Sleep`.
- **Phase 7+:** MCP (`mcp`, `ListMcpResources`, `ReadMcpResource`, `McpAuth`), `CronCreate`/`Delete`/`List` (KAIROS), `RemoteTrigger`, `LSP`, `StructuredOutput`, `REPL`, `ToolSearch`, `SendUserFile`, `PushNotification`, `SubscribePR`.

## Files

```
src/tools/
├── index.ts            # registry: getTool(name), listTools()
├── types.ts            # Tool, ToolContext, ToolResult
├── validate.ts         # JSON Schema arg validator
├── pool.ts             # assembleToolPool()
├── read/
├── edit/
├── write/
├── bash/
├── grep/
├── glob/
└── todoWrite/
```

## Checklist

### Phase 1 — V1 tools
- [ ] `types.ts` — Tool, ToolContext, ToolResult
- [ ] `validate.ts` — JSON Schema arg validation, returns ToolResult on failure
- [ ] `pool.ts` — `assembleToolPool()` with steps 1–3 + 5 (no MCP)
- [ ] `index.ts` — `getTool(name)`, `listTools()`
- [ ] Tool: Read (offset/limit, default 2000 lines, absolute paths only)
- [ ] Tool: Edit (exact replace, `replace_all`, prior-Read invariant from turn state)
- [ ] Tool: Write (overwrite ok, prior-Read invariant when file exists)
- [ ] Tool: Bash (spawn with timeout, capture stdout+stderr+exit; document the no-sandbox gap in description and help)
- [ ] Tool: Grep (shell out to `rg`; `install.sh` warns if missing; three output modes)
- [ ] Tool: Glob (Bun.Glob; sort by mtime)
- [ ] Tool: TodoWrite (states pending/in_progress/completed; exactly one in_progress)
- [ ] Each tool: unit test against a tmpdir
- [ ] Smoke test: dispatcher runs Read → Edit → Bash in a single turn against a tmpdir, transcript captures all three

### Phase 2 — Subagent + plan-mode tools
- [ ] AskUserQuestion (1–4 questions, 2–4 options, multiSelect)
- [ ] EnterPlanMode / ExitPlanMode
- [ ] Task (spawns Explore/Plan/General-purpose; thin wrapper around `subagents.spawn()`)
- [ ] TaskOutput, TaskStop

### Phase 5 — Skills, worktrees, notebooks
- [ ] Skill (invokes a SKILL.md, blocking; loads instructions into context)
- [ ] EnterWorktree / ExitWorktree (git-worktree-backed isolation; auto-cleanup if no changes)
- [ ] NotebookEdit (replace/insert/delete cell modes)

### Phase 6 — Web, PowerShell, Sleep
- [ ] WebFetch (fetch + html→md + small-model summarize; 15-min cache)
- [ ] WebSearch (provider-dependent; mandatory `Sources:` section in model output)
- [ ] PowerShell (Windows host)
- [ ] Sleep (rate-limit / poll)
