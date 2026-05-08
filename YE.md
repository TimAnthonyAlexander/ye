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
- No `any`. Explicit error types for provider-specific failures (`MissingApiKeyError`, `MissingAnthropicKeyError`).

## Build & test

- `bun install` — dependencies. Only two runtime deps: `ink` (^5.1.0) and `react` (^18.3.1).
- `bun run typecheck` — `tsc --noEmit`.
- `bun run build` — runs `scripts/install.sh` (macOS-only local install): `bun build --compile` for the host arch, outputs `dist/ye`, symlinks onto `$PATH`.
- `bun run release [vX.Y.Z]` — runs `scripts/release.sh`: cross-compiles `ye-macos` (arm64), `ye-linux` (x64), `ye-windows.exe` (x64) and publishes them as a GitHub release via `gh`. Tag defaults to `v` + `package.json` version.
- No test suite yet.
- Requires `ripgrep` on `$PATH` (Grep tool). Install script warns if missing but doesn't block.

## Architecture

Entry: `src/cli.tsx` — loads config, renders `<App>` via Ink with `exitOnCtrlC: false`. App owns the full session lifecycle.

UI layer: `src/components/`. Chat, input, status bar, todo panel, permission/user/key prompts, mention picker (file @-completion), slash-command picker. File index loaded once per session from `loadFileIndex()`.

Pipeline: `src/pipeline/`
- `queryLoop` drives turns; `runTurn` is one full 9-step turn per `PERMISSIONS.md` spec.
- Step 3 (assemble): system prompt + notes hierarchy + auto-memory → Message[].
- Step 4 (shapers): `budgetReduction` → `autoCompact` in cheapest→most-expensive order.
- Step 5-6 (model call): `dispatch.ts` streams provider events, collects text + tool_calls.
- Step 7-8 (permission gate + tool execution): sequential per tool. Prompt for non-read-only tools in NORMAL.
- Step 9 (stop check): `evaluateStop()` in `src/pipeline/stop.ts`.

Providers: `src/providers/`
- `openrouter` — default. SSE streaming, tool calls via OpenAI-compatible format.
- `anthropic` — native tool-use blocks, prompt caching at static/dynamic boundary.
- Builder pattern via `tryBuildProvider()` in `build.ts` — handles key prompts, config persistence.

Tools: 11 tools registered in `src/tools/registry.ts`. Read/Glob/Grep are read-only; others prompt in NORMAL. `Task` spawns subagents (in-process, same toolset but isolated state). `ExitPlanMode` / `EnterPlanMode` trigger mode-flip permission prompts.

Permissions: `src/permissions/`. Evaluation: pattern denies → pattern allows → mode default. `USER_DENIED` constant for uniform deny messages. `PLAN_MODE_BLOCKED` for PLAN-specific blocks.

Storage: all under `~/.ye/`. `src/storage/paths.ts` defines the layout. Sessions are append-only JSONL files (`{ts, type, ...}` per line). Project ID is a stable 12-char hex hash of the absolute project root path. Cross-session prompt history in `~/.ye/history.jsonl`.

Memory: `src/memory/`. Hierarchy: `/etc/ye/CLAUDE.md` → `~/.ye/CLAUDE.md` → project `CLAUDE.md`/`YE.md` → `YE.local.md` (gitignored). Auto-memory: LLM-based selection from `~/.ye/projects/<hash>/memory/*.md` and `~/.ye/memory/*.md` and `~/.ye/MEMORY.md`. No embeddings, no vector DB.

## Notes

- The `performance-findings.txt` at root is a temporary analysis doc — not part of the build.
- `scripts/install.sh` is the macOS-only local-dev installer (symlinks `dist/ye` onto `$PATH`). Cross-platform release binaries (macOS arm64, Linux x64, Windows x64) come from `scripts/release.sh`, which uses `bun build --compile` to cross-compile from any host and uploads to GitHub Releases via `gh`.
- Default model is `deepseek/deepseek-v4-pro` via OpenRouter (configurable in `~/.ye/config.json`).
- Subagents run in-process (no sandboxing), write sidechain transcripts under `<sessionDir>/sidechains/`, return a single summary string to the parent. Explore subagents get Read/Glob/Grep only; general subagents get the full toolset.
- Ctrl+C clears input first, then aborts the current stream — never exits. Use `/exit` to quit. Ctrl+O toggles tool-call group expansion.
- Mode cycle is Shift+Tab. Per-session mode override via `--mode AUTO|NORMAL|PLAN`.
