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

## Registered tools

Fifteen tools. Subagents, web tools, skills, and memory tools shipped; MCP deferred.

| Tool | readOnly | Notes |
|------|----------|-------|
| Read | yes | Default 2000-line slice; `offset` + `limit` supported. Absolute paths only. PDF/image support deferred to Phase 6. |
| Edit | no | Exact-string replace; requires prior Read of the same file in this turn. `replace_all` flag. |
| Write | no | Creates or overwrites. If the file exists, prior Read required. |
| Bash | no | Default 2-min timeout, max 15 min. **No sandbox in v1**; documented gap. `run_in_background` deferred. |
| Grep | yes | Wraps `rg`. Modes: `content`, `files_with_matches`, `count`. |
| Glob | yes | File pattern match. Returns paths sorted by mtime. |
| TodoWrite | no | States: `pending`, `in_progress`, `completed`. Exactly one `in_progress` at a time. In-memory; flushes via session JSONL. |
| AskUserQuestion | yes | One question, 2–4 options, optional multi-select. |
| Task | no | Spawns a subagent (`explore` / `general` / `verification`). Sidechain transcript, single summary returned. |
| WebFetch | yes | Fetch a URL, HTML→markdown, small-model summarise. 15-min cache. HTTP auto-upgrades to HTTPS. Cross-host redirects fail closed. |
| WebSearch | yes | Web search. Anthropic server-side when available, Brave / DuckDuckGo fallback. Title + URL only; follow up with WebFetch to read content. |
| Skill | yes | Invoke a registered skill by name. Read-only metadata load; the skill body may instruct the model to call other tools. |
| SaveMemory | no | Persist a memory note under the project's memory dir; auto-selected in future sessions. |
| EnterPlanMode | no | Model-initiated request to flip *into* PLAN mode. Triggers a permission prompt. |
| ExitPlanMode | no | Writes the proposed plan to `getProjectPlansDir(projectId)/<word>-<word>.md`, then fires a permission prompt to flip out of PLAN mode. The **only state-modifying tool allowed in PLAN mode** (alongside Skill, which is read-only). |

### Notable design calls

- **Read-then-Edit invariant** is tracked in turn-local state, not on disk. Each subagent sees its own invariant.
- **Bash without sandbox in v1** is a documented limitation. Until Phase 5 adds sandboxing, `acceptAll` is genuinely "trust me". This is loud in the help text.
- **No PowerShell in v1** (Phase 6).
- **TodoWrite is in-memory.** Persists to the session JSONL via standard transcript flush. Survives resume in Phase 4.
- **Grep shells out to `rg`.** Documented dependency; install script checks for it. We do not implement a JS regex search — performance and correctness aren't worth re-deriving.
- **No `dangerouslyDisableSandbox` flag in v1.** It only makes sense once we have a sandbox to disable. Phase 5.
- **`ExitPlanMode` writes before it prompts.** The plan file lands on disk in `~/.ye/projects/<hash>/plans/<word>-<word>.md` *before* the permission prompt fires. If the user denies the mode-flip, the plan stays as an orphan — which matches the "plans persist deliberately" intent. Cleanup is manual. (Alternative was write-on-accept; rejected — adds a temp-file dance for a single-user tool.)
- **Plan filename comes from `randomPlanName()`** in `src/storage/wordlist.ts`. No tool generates filenames inline.

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

- **Phase 2:** `Task` (subagent), `TaskOutput`, `TaskStop`, `EnterPlanMode` (model-initiated mode flip; the user already has Shift+Tab from v1 — this is the symmetric path for the model), `AskUserQuestion`. **All shipped.**
- **Web tools (shipped early):** `WebFetch` (fetch + html→md + small-model summarize; 15-min cache; cross-host redirects fail closed), `WebSearch` (Anthropic server-side search or DuckDuckGo fallback; title+URL only). Originally Phase 6; pulled forward.
- **Phase 5:** `Skill` — **shipped**. `SaveMemory` — **shipped**. `EnterWorktree`, `ExitWorktree`, `NotebookEdit` — pending.
- **Phase 6:** `PowerShell`, `Sleep`.
- **Phase 7+:** MCP (`mcp`, `ListMcpResources`, `ReadMcpResource`, `McpAuth`), `CronCreate`/`Delete`/`List` (KAIROS), `RemoteTrigger`, `LSP`, `StructuredOutput`, `REPL`, `ToolSearch`, `SendUserFile`, `PushNotification`, `SubscribePR`.

## Files

```
src/tools/
├── index.ts            # registry: getTool(name), listTools()
├── registry.ts         # the TOOLS array — single source of truth for built-ins
├── types.ts            # Tool, ToolContext, ToolResult
├── validate.ts         # JSON Schema arg validator
├── pool.ts             # assembleToolPool()
├── read/
├── edit/
├── write/
├── bash/
├── grep/
├── glob/
├── todoWrite/
├── webFetch/
├── webSearch/
├── webShared/          # shared: domainGate, etc.
├── askUserQuestion/
├── enterPlanMode/
├── exitPlanMode/
├── task/
├── skill/
└── saveMemory/
```

## Checklist

### Phase 1 — V1 tools
- [x] `types.ts` — Tool, ToolContext, ToolResult
- [x] `validate.ts` — JSON Schema arg validation, returns ToolResult on failure
- [x] `pool.ts` — `assembleToolPool()` with steps 1–3 + 5 (no MCP)
- [x] `index.ts` — `getTool(name)`, `listTools()`
- [x] Tool: Read (offset/limit, default 2000 lines, absolute paths only)
- [x] Tool: Edit (exact replace, `replace_all`, prior-Read invariant from turn state)
- [x] Tool: Write (overwrite ok, prior-Read invariant when file exists)
- [x] Tool: Bash (spawn with timeout, capture stdout+stderr+exit; document the no-sandbox gap in description and help)
- [x] Tool: Grep (shell out to `rg`; `install.sh` warns if missing; three output modes)
- [x] Tool: Glob (Bun.Glob; sort by mtime)
- [x] Tool: TodoWrite (states pending/in_progress/completed; exactly one in_progress)
- [x] Tool: ExitPlanMode (write plan to `getProjectPlansDir(projectId)/<randomPlanName()>.md` then return a result that triggers a permission prompt to flip out of PLAN mode; on denial, plan stays on disk)
- [x] Tool: WebFetch (fetch URL, HTML→markdown, small-model summarise via configured model; 15-min cache by URL; cross-host redirects fail closed; HTTP auto-upgrades to HTTPS; domain gate with built-in + config block/allow lists)
- [x] Tool: WebSearch (Anthropic server-side web_search when available, DuckDuckGo HTML-scrape fallback; configurable via `webTools.searchFallback`; per-call `allowed_domains`/`blocked_domains`; returns title+URL only)
- [x] `webShared/domainGate.ts` — shared domain gate (built-in blocklist, user config allow/block, per-call allow/block overrides)
- [x] Each tool: unit test against a tmpdir
- [x] Smoke test: dispatcher runs Read → Edit → Bash in a single turn against a tmpdir, transcript captures all three
- [ ] Smoke test: ExitPlanMode in PLAN mode writes a plan file, prompts, and on accept flips mode to NORMAL; on deny, mode stays PLAN and plan file remains

### Phase 2 — Subagent + model-side mode tools
- [x] AskUserQuestion (1 question, 2–4 options, multiSelect; options accept plain string OR `{label, description?}`; "Type something…" escape hatch + Esc dismissal flow)
- [x] EnterPlanMode (model-initiated flip into PLAN mode; ExitPlanMode is already Phase 1)
- [x] Task (spawns Explore / General-purpose; thin wrapper around `subagents.spawn()`)
- [ ] TaskOutput, TaskStop (subagents run synchronously inside `Task.execute()` in v2 — no in-flight management API needed yet)

### Phase 5 — Skills, worktrees, notebooks
- [x] Skill (invokes a SKILL.md, blocking; loads instructions into context). Read-only — no permission prompt in NORMAL.
- [x] SaveMemory (persists a memory note under the project memory dir; surfaces in auto-memory selection in later sessions)
- [ ] EnterWorktree / ExitWorktree (git-worktree-backed isolation; auto-cleanup if no changes)
- [ ] NotebookEdit (replace/insert/delete cell modes)

### Phase 6 — PowerShell, Sleep
- [ ] PowerShell (Windows host)
- [ ] Sleep (rate-limit / poll)
