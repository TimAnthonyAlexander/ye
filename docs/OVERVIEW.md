# Ye — Overview

Ye is a local Claude Code clone. TypeScript on Bun, terminal UI in React/Ink, multi-provider (OpenRouter first, then Claude direct and OpenAI), all state on disk under `~/.ye/`.

It exists because Claude Code is great but closed. Ye is the same shape — a ReAct agent loop with deny-first permissions, append-only transcripts, pluggable tools — built so that I can use it daily, extend it however I want, and run it on whatever model I want.

## Principles

- **KISS at every step.** The end state is large because the surface area is large, not because any one piece is clever. Each subsystem stays simple. The day Ye looks "complicated" is the day a piece of it should be split.
- **No duplicated decision logic.** One file owns each rule (project root resolution, project notes file selection, path canonicalization, permission decision). If a rule appears in two places, one of those is wrong.
- **Architect for deferred features.** MCP, hooks, KAIROS, telemetry, anti-distillation, undercover mode — none of these are in v1. The seams where they will live are documented in their respective docs so we don't trap ourselves.
- **Immutability.** New objects, never mutate.
- **Many small files.** 200–400 lines typical, 800 max. Organize by domain, not by type.
- **Convention enforcement is solo-review.** Mode strings, env var names, and file paths live in their resolvers, not inline. Self-reviewed for now; promote to ESLint when contributors join.

## Architecture (top-down)

Layers, in dependency order. Each is a folder under `src/` and a doc here.

1. **Storage** (`storage/`, `memory/`) — `~/.ye/` filesystem layout, project hashing, session/history transcripts, the centralized `CLAUDE.md`/`YE.md` resolver, global `MEMORY.md`. See `STORAGE.md`.
2. **Config** (`config/`) — `~/.ye/config.json` (default provider, default model). Already implemented.
3. **Providers** (`providers/`) — abstract `Provider` interface; OpenRouter v1, Anthropic + OpenAI Phase 3. See `PROVIDERS.md`.
4. **Permissions** (`permissions/`) — deny-first rule evaluation; `AUTO` + `NORMAL` + `PLAN` modes in v1 (Shift+Tab cycles). See `PERMISSIONS.md`.
5. **Tools** (`tools/`) — Read, Edit, Write, Bash, Grep, Glob, TodoWrite, ExitPlanMode for v1. See `TOOLS.md`.
6. **Pipeline** (`pipeline/`) — the 9-step turn pipeline + agent loop. Streams events. See `PIPELINE.md`.
7. **Subagents** (`subagents/`, Phase 2) — same pipeline, isolated state, sidechain transcripts. See `SUBAGENTS.md`.
8. **UI** (`ui/`, `components/`) — Ink/React TUI. Interactive only in v1; headless via the same event stream later.

The pipeline is the spine. Everything else feeds into it. Subagents reuse it.

## Phase plan

### Phase 1 — MVP (target: usable for solo coding work on macOS)
- `~/.ye/` layout + project hash + centralized notes-file resolver + session JSONL + plans directory at `~/.ye/projects/<hash>/plans/`
- OpenRouter provider (with `getContextSize()` for the auto-compact threshold)
- `AUTO` + `NORMAL` + `PLAN` permission modes (Shift+Tab cycles between them)
- 8 v1 tools (Read, Edit, Write, Bash, Grep, Glob, TodoWrite, ExitPlanMode) — **plus WebFetch, WebSearch (shipped early, originally Phase 6)**
- 9-step pipeline with one shaper: auto-compact at a configurable threshold (default 50% of context window)
- Ink UI: streaming output, tool-call display, y/n prompts, Shift+Tab mode cycler
- `ye` installable in `$PATH`

### Phase 2 — Depth
- Subagents (Explore, General-purpose) — Plan-the-subagent is intentionally absent; PLAN-the-mode covers planning
- Sidechain JSONL transcripts
- Auto-memory (LLM scan of memory-file headers, top-N)
- 4-level CLAUDE.md hierarchy
- Slash commands (`/mode`, `/clear`, `/help`, `/init`, `/provider`, `/model`, `/exit`)
- Interactive picker UI (`ctx.pick`) for any slash command needing a selection — filter-as-you-type + arrow nav + Enter/Esc

### Phase 3 — Provider parity
- Anthropic direct (with prompt caching) — **shipped**
- OpenAI — pending
- Tool-call format normalization layer — present per-provider via `adapt.ts`/`stream.ts`
- Conformance suite across all three — pending

### Phase 4 — Compaction & recovery
- The four cheaper compaction shapers (Budget Reduction → Snip → Microcompact → Context Collapse) shipped — Auto-Compact is now the last resort instead of the only resort. See `PIPELINE.md` for thresholds, mechanics, and Phase 4.5 deferrals (smart-staleness Snip, LLM-summary Microcompact, message UUIDs + read-time projection)
- **Recovery layer shipped** — `src/pipeline/recovery.ts` wraps step 5/6 with a typed retry orchestrator over `ProviderError`: token-budget escalation, streaming → batch fallback, prompt-too-long shaper escalation, and cross-provider fallback model. Configurable via `recovery.{maxRetries, backoffBaseMs, backoffMaxMs, fallbackModel}`. See PIPELINE.md "Recovery (Phase 4 — shipped)"
- **Session resume shipped** — `ye --resume [<sessionId>]` flag + `/resume` slash command. Replays the session JSONL into a `Message[]` history via `replaySessionFile()`; permissions are not restored (hard rule). Cross-session prompt history (`~/.ye/history.jsonl`) was already in
- **File-history checkpoints shipped** — Edit/Write snapshot the original before mutating into `~/.ye/projects/<hash>/checkpoints/<sessionId>/<globalTurnIndex>/`. `/rewind` opens a picker over user prompts in the current session, restores files via `rewindToTurn()`, and truncates conversation history with an append-only `rewind` JSONL marker honored at replay time

### Phase 5 — Extensibility
- Skills (`SKILL.md`, SkillTool)
- Hooks (PreToolUse, PostToolUse, Stop)
- Worktree isolation for subagents
- Remaining permission modes (acceptEdits, dontAsk, bypassPermissions, bubble) + auto-classifier

### Phase 6 — Headless + cross-platform
- `ye -p "prompt"` headless mode
- Linux x64 build, Windows x64 build
- PowerShell tool

### Phase 7+ — Deferred
- MCP (`mcp`, `ListMcpResources`, `ReadMcpResource`, `McpAuth`)
- Telemetry (frustration / continue counter)
- KAIROS (autonomous daemon mode + `CronCreate/Delete/List`, `RemoteTrigger`)
- Anti-distillation (poisoned schemas, beta gating)
- Undercover mode, ULTRAPLAN, Buddy, etc.

## Repo layout

```
ye/
├── docs/                  # design + checklists (this doc, etc.)
├── src/
│   ├── cli.tsx            # entrypoint
│   ├── components/        # Ink components
│   ├── config/            # ~/.ye/config.json (done)
│   ├── storage/           # ~/.ye layout, project hash, sessions
│   ├── memory/            # CLAUDE.md/YE.md resolver, MEMORY.md, hierarchy
│   ├── providers/         # Provider interface + implementations
│   ├── permissions/       # mode logic + rule eval
│   ├── tools/             # tool implementations
│   ├── pipeline/          # 9-step pipeline + agent loop
│   ├── subagents/         # Phase 2
│   └── ui/                # streaming view, prompts, status line
├── scripts/
│   └── install.sh         # build & link `ye` into $PATH
├── package.json
└── tsconfig.json
```

## Cross-cutting checklist

Items here orchestrate across multiple subdocs or don't fit any single one. Domain checklists live in their own docs.

### Phase 1 — gating items
- [x] Top-level repo scaffolding ready: `src/{storage,memory,providers,permissions,tools,pipeline,ui}` directories created with `index.ts` placeholders
- [ ] `bun test` runner wired (one passing smoke test in each domain)
- [ ] `bun run check` script: typecheck + tests + lint, single command
- [x] `scripts/install.sh` builds Ye (via `bun build --compile`) and symlinks `ye` into a `$PATH` directory (macOS arm64 + x64)
- [ ] Phase 1 acceptance: from a fresh shell, `ye` opens an Ink session, an OpenRouter call streams text, one Read + one Edit work end-to-end with a y/n prompt, the transcript lands at `~/.ye/projects/<hash>/sessions/<id>.jsonl`
- [x] Quickstart in repo root `README.md` (only after Phase 1 acceptance)

### Phase 2 — gating items
- [x] Subagent demo: `Explore` returns a useful summary; parent's context size before-vs-after the subagent run is unchanged (this is the whole point of subagents)
- [x] CLAUDE.md hierarchy + auto-memory wired into context assembly (step 3)
- [x] At least three slash commands working: `/mode`, `/clear`, `/help` (also: `/init`, `/exit`)
- [x] Interactive picker (`Picker` component + `SlashCommandContext.pick`) — used by `/mode`, `/provider`, `/model` when called without args

### Phase 3 — gating items
- [x] Anthropic provider shipped with prompt caching, tool_use/tool_result blocks, `event:`/`data:` SSE
- [x] `/provider` and `/model` slash commands switch the active provider/model mid-session (refetches context window, swaps `state.activeModel`)
- [ ] OpenAI provider
- [ ] All three providers pass the same conformance suite: text round-trip, tool-call round-trip, multi-chunk streaming, cache-hit assertion (Anthropic only)

### Build / distribute
- [x] `bun build --compile` produces a single binary on macOS arm64
- [x] macOS x64 build target (Phase 1, same script)
- [ ] Linux x64 build target (Phase 6)
- [ ] Windows x64 build target (Phase 6)
- [ ] Versioning + release script (`scripts/release.sh`, Phase 6+)

### Engineering hygiene (ongoing)
- [ ] One assertion lib only (Bun's `expect`); set in stone before tests proliferate
- [ ] Lint rule: no relative imports going up more than two `..`
- [ ] No file > 800 lines (CI check)
