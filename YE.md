# Ye — project notes

## Conventions

- TypeScript on Bun, `tsc --noEmit` for typechecking (`bun run typecheck`). No emit — Bun runs `.ts` / `.tsx` directly.
- Module system: ESNext, `verbatimModuleSyntax`, `.ts` extensions in all imports (Bun resolution). `allowImportingTsExtensions: true`.
- JSX: `react-jsx` (Ink 5).
- Formatting: Prettier (`bun run format` / `bun run format:check`). No other linter configured.
- Strictest tsconfig flags: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`.
- Run cycle: `bun run dev` for watch-mode, `bun run start` for single run. The built binary path is `./scripts/install.sh`.
- Comments: zero by default. Add one only for non-obvious WHY (hidden constraint, invariant, workaround). Never for WHAT — identifiers carry that.
- No defensive programming against internal state — validate at system boundaries only (user input, external APIs, config load). Internal code is trusted.
- `readonly` on all interface/type fields that aren't mutated after construction.
- Async generators for streaming pipeline hooks (`queryLoop`, `runTurn`). Events flow as `AsyncGenerator<Event>`.
- No `any`. Explicit error types for provider-specific failures (`MissingApiKeyError`, `MissingAnthropicKeyError`, `MissingOpenAIKeyError`).

## Build & test

- `bun install` — dependencies. Three runtime deps: `ink` (^5.1.0), `react` (^18.3.1), and `turndown` (^7.2.0).
- `bun run typecheck` — `tsc --noEmit`.
- `bun test` — runs Bun's test runner against the in-tree `*.test.ts` files (pipeline turn/state/stop/recovery, shapers, permissions, hooks, tool pool, edit diff).
- `bun run check` — combined typecheck + format check + tests, the pre-commit gate.
- `bun run build` — runs `scripts/install.sh` (macOS-only local install): `bun build --compile` for the host arch, outputs `dist/ye`, symlinks onto `$PATH`.
- `bun run release [vX.Y.Z]` — runs `scripts/release.sh`: cross-compiles `ye-macos` (arm64), `ye-linux` (x64), `ye-windows.exe` (x64) and publishes them as a GitHub release via `gh`. Tag defaults to `v` + `package.json` version.
- Requires `ripgrep` on `$PATH` (Grep tool). Install script warns if missing but doesn't block.

## Architecture

Entry: `src/cli.tsx` — parses flags (`--resume [id]`, `--mode`, `-p/--prompt` for headless, `--update`/`--upgrade` for self-update), loads config, renders `<App>` via Ink with `exitOnCtrlC: false`. App owns the full session lifecycle. Headless path (`-p`) bypasses Ink and streams to stdout via `pipeline/headless.ts`.

UI layer: `src/components/`. Home screen + recents picker, chat, input with @-mention picker and slash-command picker, status bar, todo panel, permission/key/user prompts, edit diff renderer. File index loaded once per session from `loadFileIndex()`.

Pipeline: `src/pipeline/`
- `queryLoop` drives turns; `runTurn` is one full 9-step turn per `PERMISSIONS.md` spec.
- Step 3 (assemble): system prompt + notes hierarchy + auto-memory → Message[].
- Step 4 (shapers): cheapest→most-expensive chain `budgetReduction → snip → microcompact → contextCollapse → autoCompact`. Each shaper checks its own trigger, returns `skip`/`applied`/`done`. History is re-assembled after each `applied`. Hard cap of 4 applications per turn (defense against retry-loop bugs).
- Step 5-6 (model call): `dispatch.ts` streams provider events; `recovery.ts` wraps the call with retry + exponential backoff (3 retries, 500ms→8s).
- Step 7-8 (permission gate + tool execution): sequential per tool. Prompt for non-read-only tools in NORMAL.
- Step 9 (stop check): `evaluateStop()` in `src/pipeline/stop.ts`.

Providers: `src/providers/`
- `openrouter` — default. SSE streaming, OpenAI-compatible tool calls, context window discovered via `/models`. Provider routing supports cheapest-first via `providerSort`.
- `anthropic` — native tool-use blocks, prompt caching at static/dynamic boundary.
- `openai` — Responses API v1, interleaved reasoning, strict tool schema.
- Builder pattern via `tryBuildProvider()` in `build.ts` — handles key prompts, config persistence.
- Single source of truth for the model picker is `models.ts`. Per-call USD cost tracking lives in `pricing.ts`.

Tools: 15 tools registered in `src/tools/registry.ts` — Read, Edit, Write, Bash, Grep, Glob, TodoWrite, ExitPlanMode, EnterPlanMode, AskUserQuestion, Task, WebFetch, WebSearch, Skill, SaveMemory. Read/Glob/Grep/AskUserQuestion/Skill/WebFetch/WebSearch are read-only (auto-allow in NORMAL); the rest prompt. `Task` spawns subagents (in-process, isolated state). `ExitPlanMode` / `EnterPlanMode` trigger mode-flip permission prompts.

Subagents: `src/subagents/`. Three kinds, each with its own system prompt, tool whitelist, and turn budget:
- `explore` — codebase search, read-only (Read/Glob/Grep). `thoroughness` knob controls budget.
- `general` — full toolset, AUTO mode.
- `verification` — narrow, post-change verification subagent.

Permissions: `src/permissions/`. Evaluation: pattern denies → pattern allows → mode default. `USER_DENIED` constant for uniform deny messages. `PLAN_MODE_BLOCKED` for PLAN-specific blocks.

Hooks: `src/hooks/`. Event-matched shell hooks loaded from config: `PreCompact` (gate the shaper chain), tool-call lifecycle hooks, etc. Runner is in `runner.ts`.

Storage: all under `~/.ye/`. `src/storage/paths.ts` defines the layout. Sessions are append-only JSONL files (`{ts, type, ...}` per line). Project ID is a stable 12-char hex hash of the absolute project root path. Cross-session prompt history in `~/.ye/history.jsonl`. Per-call usage in `~/.ye/usage.jsonl`. Turn checkpoints under `<projectDir>/checkpoints/<sessionId>/<turnIndex>/` power `/rewind`.

Memory: `src/memory/`. Hierarchy: `/etc/ye/CLAUDE.md` → `~/.ye/CLAUDE.md` → project `CLAUDE.md`/`YE.md` → `YE.local.md` (gitignored). Auto-memory: LLM-based selection from `~/.ye/projects/<hash>/memory/*.md` and `~/.ye/memory/*.md` and `~/.ye/MEMORY.md`. No embeddings, no vector DB.

Slash commands: `src/commands/`. Built-ins are `/help /clear /copy /mode /provider /model /resume /rewind /init /exit`. Skill-bound commands register dynamically via `setExtraCommands` and lose to built-ins on name conflict.

## Notes

- `performance-findings.txt` at root is a temporary analysis doc — not part of the build.
- `scripts/install.sh` is the macOS-only local-dev installer (symlinks `dist/ye` onto `$PATH`). Cross-platform release binaries (macOS arm64, Linux x64, Windows x64) come from `scripts/release.sh`, which uses `bun build --compile` to cross-compile from any host and uploads to GitHub Releases via `gh`.
- Default model is `~google/gemini-flash-latest` via OpenRouter (configurable in `~/.ye/config.json`). Default `compact.threshold` is 0.5 (auto-compact at 50% of context).
- Subagents run in-process (no sandboxing), write sidechain transcripts under `<sessionDir>/sidechains/`, return a single summary string to the parent. Explore subagents get Read/Glob/Grep only; general subagents get the full toolset.
- Self-update path: `ye --update` (or `--upgrade`) downloads the latest release binary for the current platform and swaps it in. Background update check on launch surfaces in the status bar.
- Ctrl+C clears input first, then aborts the current stream — never exits. Use `/exit` to quit. Ctrl+O toggles tool-call group expansion.
- Mode cycle is Shift+Tab. Per-session mode override via `--mode AUTO|NORMAL|PLAN`.
