# Ye — Overview

Ye is a local Claude Code clone. TypeScript on Bun, terminal UI in React/Ink, multi-provider (OpenRouter first, then Claude direct and OpenAI), all state on disk under `~/.ye/`.

It exists because Claude Code is great but closed. Ye is the same shape — a ReAct agent loop with deny-first permissions, append-only transcripts, pluggable tools — built so that I can use it daily, extend it however I want, and run it on whatever model I want.

## Principles

- **KISS at every step.** The end state is large because the surface area is large, not because any one piece is clever. Each subsystem stays simple. The day Ye looks "complicated" is the day a piece of it should be split.
- **No duplicated decision logic.** One file owns each rule (project root resolution, project notes file selection, path canonicalization, permission decision). If a rule appears in two places, one of those is wrong.
- **Architect for deferred features.** MCP, hooks, KAIROS, telemetry, anti-distillation, undercover mode — none of these are in v1. The seams where they will live are documented in their respective docs so we don't trap ourselves.
- **Immutability.** New objects, never mutate.
- **Many small files.** 200–400 lines typical, 800 max. Organize by domain, not by type.

## Architecture (top-down)

Layers, in dependency order. Each is a folder under `src/` and a doc here.

1. **Storage** (`storage/`, `memory/`) — `~/.ye/` filesystem layout, project hashing, session/history transcripts, the centralized `CLAUDE.md`/`YE.md` resolver, global `MEMORY.md`. See `STORAGE.md`.
2. **Config** (`config/`) — `~/.ye/config.json` (default provider, default model). Already implemented.
3. **Providers** (`providers/`) — abstract `Provider` interface; OpenRouter v1, Anthropic + OpenAI Phase 3. See `PROVIDERS.md`.
4. **Permissions** (`permissions/`) — deny-first rule evaluation; `default` + `acceptAll` modes in v1. See `PERMISSIONS.md`.
5. **Tools** (`tools/`) — Read, Edit, Write, Bash, Grep, Glob, TodoWrite for v1. See `TOOLS.md`.
6. **Pipeline** (`pipeline/`) — the 9-step turn pipeline + agent loop. Streams events. See `PIPELINE.md`.
7. **Subagents** (`subagents/`, Phase 2) — same pipeline, isolated state, sidechain transcripts. See `SUBAGENTS.md`.
8. **UI** (`ui/`, `components/`) — Ink/React TUI. Interactive only in v1; headless via the same event stream later.

The pipeline is the spine. Everything else feeds into it. Subagents reuse it.

## Phase plan

### Phase 1 — MVP (target: usable for solo coding work on macOS)
- `~/.ye/` layout + project hash + centralized notes-file resolver + session JSONL
- OpenRouter provider
- `default` + `acceptAll` permission modes
- 7 v1 tools (Read, Edit, Write, Bash, Grep, Glob, TodoWrite)
- 9-step pipeline (lean: shaper = trim oldest only)
- Ink UI: streaming output, tool-call display, y/n prompts
- `ye` installable in `$PATH`

### Phase 2 — Depth
- Subagents (Explore, Plan, General-purpose)
- Sidechain JSONL transcripts
- Auto-memory (LLM scan of memory-file headers, top-N)
- 4-level CLAUDE.md hierarchy
- Slash commands (`/mode`, `/clear`, etc.)

### Phase 3 — Provider parity
- Anthropic direct (with prompt caching)
- OpenAI
- Tool-call format normalization layer
- Conformance suite across all three

### Phase 4 — Compaction & recovery
- Full 5-stage compaction (Snip → Microcompact → Context Collapse → Auto-Compact)
- Token-budget escalation, retries, fallback model
- Session resume + cross-session prompt history (`~/.ye/history.jsonl`)
- File-history checkpoints

### Phase 5 — Extensibility
- Skills (`SKILL.md`, SkillTool)
- Hooks (PreToolUse, PostToolUse, Stop)
- Plan mode
- Worktree isolation for subagents
- Full 7-mode permission set + auto-classifier

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
- [ ] Top-level repo scaffolding ready: `src/{storage,memory,providers,permissions,tools,pipeline,ui}` directories created with `index.ts` placeholders
- [ ] `bun test` runner wired (one passing smoke test in each domain)
- [ ] `bun run check` script: typecheck + tests + lint, single command
- [ ] `scripts/install.sh` builds Ye (via `bun build --compile`) and symlinks `ye` into a `$PATH` directory (macOS arm64 + x64)
- [ ] Phase 1 acceptance: from a fresh shell, `ye` opens an Ink session, an OpenRouter call streams text, one Read + one Edit work end-to-end with a y/n prompt, the transcript lands at `~/.ye/projects/<hash>/sessions/<id>.jsonl`
- [ ] Quickstart in repo root `README.md` (only after Phase 1 acceptance)

### Phase 2 — gating items
- [ ] Subagent demo: `Explore` returns a useful summary; parent's context size before-vs-after the subagent run is unchanged (this is the whole point of subagents)
- [ ] CLAUDE.md hierarchy + auto-memory wired into context assembly (step 3)
- [ ] At least three slash commands working: `/mode`, `/clear`, `/help`

### Phase 3 — gating items
- [ ] All three providers pass the same conformance suite: text round-trip, tool-call round-trip, multi-chunk streaming, cache-hit assertion (Anthropic only)

### Build / distribute
- [ ] `bun build --compile` produces a single binary on macOS arm64
- [ ] macOS x64 build target (Phase 1, same script)
- [ ] Linux x64 build target (Phase 6)
- [ ] Windows x64 build target (Phase 6)
- [ ] Versioning + release script (`scripts/release.sh`, Phase 6+)

### Engineering hygiene (ongoing)
- [ ] One assertion lib only (Bun's `expect`); set in stone before tests proliferate
- [ ] Lint rule: no relative imports going up more than two `..`
- [ ] No file > 800 lines (CI check)
- [ ] No tool/file references mode strings, env var names, or paths inline — they live in their respective resolvers
