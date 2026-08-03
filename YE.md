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
- No `any`. Explicit error types for provider-specific failures (`MissingApiKeyError`, `MissingAnthropicKeyError`, `MissingOpenAIKeyError`). Ollama does not throw a missing-key error — local server, no auth by default.
- Never write a literal control character into a source file. Use an escape (`\0`, `\r\n`, `\x1b`) — a raw byte makes the file binary to git and diffs become useless.

## Build & test

- `bun install` — dependencies. Three runtime deps: `ink` (^5.1.0), `react` (^18.3.1), and `turndown` (^7.2.0). The LSP client is hand-rolled precisely to avoid a fourth.
- `bun run typecheck` — `tsc --noEmit`.
- `bun test` — Bun's test runner against the in-tree `*.test.ts` files.
- `bun run check` — combined typecheck + format check + tests, the pre-commit gate.
- `bun run build` — runs `scripts/install.sh` (macOS-only local install): `bun build --compile` for the host arch, outputs `dist/ye`, symlinks onto `$PATH`.
- `bun run release [vX.Y.Z]` — runs `scripts/release.sh`: cross-compiles `ye-macos` (arm64), `ye-linux` (x64), `ye-windows.exe` (x64) and publishes them as a GitHub release via `gh`. Tag defaults to `v` + `package.json` version.
- Requires `ripgrep` on `$PATH` (Grep tool). Install script warns if missing but doesn't block.
- Known test hazard: `src/pipeline/executeToolCalls.test.ts` mocks `../hooks/index.ts` process-globally. A test that passes alone but fails in the full suite is usually colliding with that.

## Architecture

Entry: `src/cli.tsx`. Flag parsing lives in `src/cli/flags.ts` (separate module so it is testable — `cli.tsx` runs `main()` at import). Flags: `-p/--prompt`, `--mode`, `--resume [id]`, `--output-format text|json|stream-json`, `--max-budget-usd`, `--update`/`--upgrade`, `-h/--help`, `-v/--version`. An unrecognised flag errors and exits 1. With no `-p` and a non-TTY stdin the prompt is read from stdin (`echo "fix it" | ye`), capped at 10MB. Headless bypasses Ink and streams via `pipeline/headless.ts`; `src/cli/output.ts` holds the machine-readable serialisers.

UI layer: `src/components/`. Home screen + recents picker, chat, input, status bar, todo panel, permission/key/user prompts, edit diff renderer. File index loaded once per session from `loadFileIndex()`.

Pipeline: `src/pipeline/`

- `queryLoop` drives turns; `runTurn` is one full turn.
- Assemble: system prompt + notes hierarchy + auto-memory → `Message[]`. Full prompt ~16k tokens; Ollama and small models get a compact variant (~4k) via `buildSmallSystemPrompt()`.
- Shapers: cheapest→most-expensive chain `budgetReduction → snip → microcompact → contextCollapse → autoCompact`. Each returns `skip`/`applied`/`done`; history is re-assembled after each `applied`. Hard cap of 4 applications per turn. `PreCompact` hook can block the chain. `/compact [focus]` drives the same summariser on demand via `shapers/manualCompact.ts`.
- Model call: `dispatch.ts` streams provider events; `recovery.ts` wraps with retry + backoff, streaming→batch fallback, forced shaper escalation on `prompt_too_long`, and a `fallbackModel` last resort.
- Permission gate + tool execution: read-only tools whose gate decision is `allow` fan out in parallel; everything else runs sequentially.
- Stop check: `evaluateStop()` in `stop.ts`. Reasons: `end_turn`, `max_turns`, `context_overflow`, `plan_loop_guard`, `budget_exhausted`, `user_cancel`, `error`, `continue`.
- Verify loop (`verify.ts`): when the chain would end and something was written, runs `verify.typecheck → lint → test`, stopping at the first failure. A failure is injected as a `<system-reminder>` and the chain continues so the model fixes it; success injects nothing. Capped at 2 continuations. Main chain only — `state.parentSessionId` marks a subagent run, and without that gate every subagent ending its chain would fire the whole suite.
- Budget: `--max-budget-usd` / `config.budget.maxUsd`, checked before dispatch so nothing is spent past the cap.

Providers: `src/providers/` — `openrouter` (default), `anthropic`, `openai`, `deepseek`, `ollama`.

- `openrouter` — SSE, OpenAI-compatible tool calls, context window from `/models`, routing via `providerSort`, server-side web search/fetch, per-model reasoning policy in `reasoningPolicy.ts`.
- `anthropic` — native tool-use blocks, three `cache_control` breakpoints.
- `openai` — Responses API, `store:false`, strict tool schemas, encrypted reasoning round-trip.
- `deepseek` — implicit prefix caching, native reasoning round-trip.
- `ollama` — local, keyless, NDJSON streaming, context size from `/api/show`.
- `tryBuildProvider()` in `build.ts` handles key prompts and config persistence. Model picker source of truth is `models.ts`; per-call USD in `pricing.ts`.
- `internalCall.ts` routes calls the user never reads — compaction summaries, session titles, auto-memory selection, WebFetch summaries, prompt suggestions — to `config.cheapModel` with reasoning disabled. Precedence: `webTools.summarizeModel` (WebFetch only) → `cheapModel` → active model. The cheap model may live on another provider, built through the same path `recovery.ts` uses for `fallbackModel`. If it cannot be built the call falls back to the active model — a missing cheap model must never break compaction.

Tools: 25 registered in `src/tools/registry.ts` — Read, Edit, Write, Bash, BashOutput, Grep, Glob, Definition, References, SymbolSearch, Diagnostics, TodoWrite, ExitPlanMode, EnterPlanMode, AskUserQuestion, Task, TaskOutput, KillAgent, Monitor, KillMonitor, WebFetch, WebSearch, Skill, SaveMemory, KillShell. The three LSP navigation tools leave `listTools()` when no language server is configured, so the pool drops to 22 and the model never wastes a turn on them. Read-only (auto-allow in NORMAL): Read, Glob, Grep, Definition, References, SymbolSearch, Diagnostics, AskUserQuestion, Skill, WebFetch, WebSearch, BashOutput, TaskOutput. The PLAN allowlist (`src/permissions/modes.ts`) is narrower than "read-only" — it includes the LSP tools but excludes Diagnostics, which runs an arbitrary user-configured command.

Edit/Write run the configured formatter after a successful write (`src/tools/format.ts`, gated on `format.enabled`). A formatter failure never fails the edit — the file is already written, and reporting failure makes the model retry and duplicate work. The recorded content hash is refreshed after a formatter rewrites a file, otherwise the next Edit is wrongly rejected as drifted.

Async work: `Task` runs in the background by default, `Bash` on `run_in_background: true`, and `Monitor` polls a condition. Managers in `src/subagents/background.ts` and `src/tools/bash/background.ts` hold results until a turn drains them into history as `<system-reminder>`s. `pipeline/backgroundWakeup.ts` races all three round-robin from a moving cursor, so a kind that always has a result waiting cannot starve the others; both the Ink loop and headless pump turns off it. Background tasks default to the 900s ceiling, not the 120s foreground default.

Subagents: `src/subagents/`. Four built-in kinds plus user-defined ones:

- `explore` — codebase search (Read/Glob/Grep + the LSP navigation tools). `thoroughness` sets the budget.
- `general` — full toolset, AUTO mode.
- `verification` — post-change verification (Read/Glob/Grep/Bash/Diagnostics).
- `fork` — inherits a deep copy of the parent's live in-memory history plus a message stating that it is a fork and what its task is. Model-facing only; there is no slash command. The copy shares no object with the parent so the fork's shapers cannot write back, and the seed is trimmed at a clean tool-call boundary so no orphaned tool call reaches the provider. `parentHistory` rides on `SubagentToolContext` — seeding from a transcript replay would miss the current turn.
- Custom agents from `.ye/agents/*.md` (`src/subagents/catalogue.ts`): `name`, `description`, `tools`, `model`, `maxTurns`. Declared tools are intersected with the built-in ceiling and `Task` is always excluded, so a file can only narrow; `maxTurns` stays clamped by `config.maxTurns.subagent`. Built-ins beat project, project beats user. The `Task` kind enum is built from the live catalogue.

None of them can spawn a `Task` — recursion guard.

Permissions: `src/permissions/`. Evaluation order: pattern denies → pattern allows → mode default → heuristic gate as a safety floor that can only tighten. `match.ts` holds the pattern language: an explicit per-tool subject map (Bash → `command`, Read/Edit/Write/Glob/Grep → `path`, WebFetch → `url`, …), glob matching for path subjects against absolute tilde-expanded paths, wildcards for commands. An allow rule fires only when **every** chained segment matches, so `Bash(git status)` does not permit `git status && rm -rf /`; a deny fires when **any** segment matches. Allow also refuses segments containing command substitution unless the rule names it. Patterns ending in `:*` keep v1 `startsWith` semantics for backward compatibility.

Prompt responses are `allow_once`, `allow_session`, `allow_always`, `deny`. Session grants are written to the session JSONL and restored on replay (gated on `permissions.persistSessionRules`, default on), tagged with the prompt ordinal so a rewind past a grant discards it. `allow_always` derives the narrowest rule it can (`npm run build` → `Bash(npm *)`, an edit → `Edit(<dir>/**)`), shows the exact text before the user accepts, and refuses to derive from chained commands, command substitution, wrappers that can run anything, risky commands, or paths at or above `$HOME`.

Hooks: `src/hooks/`. Seven events — `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `PreCompact`, `SessionStart`. Exit code 2 blocks.

Skills: `src/skills/`. Agent-Skills-compatible loader. Honoured frontmatter: `name`, `description`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `argument-hint`. Tool scoping **intersects** — a skill can never hand back a tool the mode stripped. Scope is per-session (`skills/scope.ts`), cleared when the chain ends. Unknown keys are ignored; malformed values skip the key, not the skill.

LSP: `src/lsp/` + `src/tools/lspTools/`. Hand-rolled stdio client — byte-level frame buffering so a response split mid-header or mid-body reassembles, one lazily spawned server per language reused across calls, 10s request timeouts, in-flight requests rejected when a server dies. Scoped to navigation only; `Diagnostics` owns compiler output. Line/column are 1-based in the tool API, converted at exactly one place. Tests drive a fake server (`src/lsp/fixtures/fakeServer.ts`) speaking real framed JSON-RPC with its own parser.

LSP install: `src/lsp/install/`. A language server is useless if the user has to install it themselves, so Ye offers. `catalogue.ts` holds one entry per language (typescript, python, go, rust) with its binary, markers, prerequisite and install plan; `detect.ts` derives its detection table from the same catalogue, so adding a language is one edit.

Servers install under `~/.ye/lsp` — node servers into a private package root, `gopls` into `bin/` via `GOBIN`. `rm -rf ~/.ye/lsp` is a complete uninstall. `rust-analyzer` is the exception: it goes through `rustup component add`, mutates a toolchain Ye does not own, is tagged `toolchain` scope, and uninstall prints the command rather than running it.

One builder feeds both the string shown to the user and the argv spawned, so consent cannot be given for one command and another run. Installs are verified afterwards by resolving and probing the binary — a package manager exiting 0 without producing a working server is a failure. No `sudo`, ever.

`offer.ts` is the policy layer. `pendingOffers()` returns nothing when the session is non-interactive, `lsp.autoInstall` is false, `lsp.enabled` is false, `autoDetect` is false, the project has no marker, a server already resolves (including a catalogue alternate like `pylsp`), the language was declined, or the prerequisite is missing. Only declines persist, to `~/.ye/lsp/state.json` — "installed" is derived by resolving the binary and so cannot go stale. A corrupt state file reads as no declines rather than failing the session.

The offer surfaces once at session start as a non-modal banner (Ctrl+L to answer); ignoring it and typing is not consent. `/lsp` shows status and drives install/uninstall explicitly, and `/doctor` explains why LSP is off. Ye-installed binaries resolve before `$PATH` and are spawned by absolute path — a modified `PATH` is inherited by children but not by anything they re-exec. After an install `invalidateLspAvailability()` makes the navigation tools appear on the next turn with no restart.

Monitors: `src/monitors/`. Ye can be woken by work it started, but nothing let it wait on state it does not own — a job finishing on a remote host, a CI run going green, a log line appearing, a wall-clock time arriving. A background bash `until` loop cannot do it either: `resolveTimeoutMs` hard-clamps to `MAX_TIMEOUT_MS` (900s) and real waits are hours.

A monitor polls a cheap shell `condition` on an interval (default 30s, floor 5s) and completes when it succeeds, then runs `capture` once for the payload. `condition` answers *whether*, `capture` fetches *what* — keeping the condition quiet (`grep -q`) is what makes frequent polling cheap while still waking with evidence. `at` accepts an ISO timestamp or `HH:MM`; with a condition the two combine as OR, whichever fires first.

The error taxonomy is load-bearing: exit 0 is met, exit 1 is not yet, anything else — a non-{0,1} exit, a spawn failure, a poll timeout — is an error, and errors must be **consecutive** to matter (one flake between not-yets resets the counter). Three in a row stop the monitor as `broken` with the last stderr. A monitor spinning silently for a day because an SSH key expired is the failure this design exists to prevent. `gave_up` means the condition was never observed true, and is never reported as a fact about the underlying work.

Monitors are a third `BackgroundKind` and drain into history as `<system-reminder>`s exactly like background bash and subagents. They live only as long as the session, are torn down at `/clear` and unmount and in the headless `finally`, and in a `-p` run the deadline is clamped to an hour so a headless run cannot hang. `/monitors` lists them, `KillMonitor` and `/monitors kill` stop one.

Storage: all under `~/.ye/`. `src/storage/paths.ts` defines the layout. Sessions are append-only JSONL. Project ID is a stable 12-char hex hash of the absolute project root. Cross-session prompt history in `~/.ye/history.jsonl`, per-call usage in `~/.ye/usage.jsonl`, turn checkpoints under `<projectDir>/checkpoints/<sessionId>/<turnIndex>/` powering `/rewind`.

Memory: `src/memory/`. Hierarchy: `/etc/ye/CLAUDE.md` → `~/.ye/CLAUDE.md` → project → `YE.local.md` (gitignored). At the project level it is **first found wins** across `CLAUDE.md` → `YE.md` → `AGENTS.md`, never concatenated — a repo with both `CLAUDE.md` and `AGENTS.md` reads `CLAUDE.md` only. Symlinked notes files resolve correctly (this repo's `CLAUDE.md` is a symlink to `YE.md`).

A line that is exactly `@<path>` inlines that file, resolved relative to the importing file, with `~` expansion, capped at 4 hops, cycle-safe, and skipped inside fenced code blocks. A missing target stays literal rather than failing the session.

`CLAUDE.md`/`AGENTS.md` in subdirectories load lazily: reading a file appends any notes between it and the project root as a `<system-reminder>`, once per session. Root-level files are excluded so the lazy path cannot undo first-found-wins.

Auto-memory: LLM-based selection from `~/.ye/projects/<hash>/memory/*.md`, `~/.ye/memory/*.md` and `~/.ye/MEMORY.md`. No embeddings, no vector DB.

Slash commands: `src/commands/`. Built-ins: `/help /clear /context /compact /copy /cost /status /btw /export /memory /permissions /agents /doctor /mode /provider /model /routing /resume /rewind /init /exit`.

User-defined markdown commands load from `<projectRoot>/.ye/commands/` and `~/.ye/commands/`, recursively, with subdirectories namespaced by `:` (`git/sync.md` → `/git:sync`). Frontmatter `description` and `argument-hint`; the body is sent as a hidden prompt with `$ARGUMENTS` and `$0..$N` substitution. Precedence: **built-in > project markdown > user markdown > skill**.

`/btw` asks a side question that touches neither `state.history` nor the session JSONL, so resume cannot replay it.

## Config reference (`~/.ye/config.json`)

All optional unless noted. Validated in `src/config/validate.ts`; unknown top-level keys are dropped.

- `defaultProvider`, `providers.<id>.{baseUrl, apiKeyEnv, apiKey?}`, `defaultModel.{provider, model, providerOrder?, allowFallbacks?, providerSort?, routing?}` — required core.
- `compact` — `threshold`, `defaultMaxTokens`, `minReplyTokens`, plus per-shaper tuning: `snipThreshold`, `snipFloor`, `snipProtectedTail`, `snipMaxPerTurn`, `microcompactThreshold`, `microcompactHotTail`, `microcompactMinBytes`, `collapseThreshold`, `collapsePreserveRecent`.
- `maxTurns.{master, subagent}` — the subagent value is a ceiling nothing else can raise.
- `permissions.{defaultMode, rules[], heuristicGating?, persistSessionRules?}`.
- `verify.{enabled?, lint?, test?, typecheck?, timeoutMs?}` — drives both the post-edit verify loop and the `Diagnostics` tool.
- `format.{enabled?, formatters?}` — `formatters` maps an extension glob (`"*.ts"`) to a command template; `$FILE` is substituted with the quoted path, or appended when absent.
- `budget.maxUsd` — session spend cap.
- `cheapModel.{provider, model}` — root-level; serves internal calls.
- `suggestions.enabled` — predicted next prompt.
- `lsp.{enabled?, servers?, autoInstall?}` — `servers` maps a language id (`"typescript"`) to `{command, args?}`. `autoInstall: false` suppresses install offers; it never causes an install, which always needs an explicit answer.
- `webTools`, `recovery`, `gitStatus`, `skills`, `hooks` — as before.
- `autoDetect` — root-level boolean, default true. Kill switch for the runtime detection below.

## Auto-detection (`src/config/detect.ts`)

`verify`, `format` and `lsp` need values (which command, which server), not flags, so a fresh config leaves all three dark. They are detected from the project root at runtime instead. **Nothing is ever written back to `~/.ye/config.json`** — a persisted detection goes stale and then lies about the project.

Detection is keyed on the project root the caller passes, cached in a module-level Map, and costs one `readdirSync` plus at most one `package.json` parse per root per process. A root with none of the markers detects nothing, which is why tests that pass a temp directory are unaffected.

| Block | Detected from (first match wins) |
| --- | --- |
| `verify.typecheck` | `scripts.typecheck` → `<pm> run typecheck`; `tsconfig.json` → `<pm-exec> tsc --noEmit`; `Cargo.toml` → `cargo check`; `go.mod` → `go build ./...` |
| `verify.lint` | `scripts.lint` → `<pm> run lint`; `.eslintrc*` / `eslint.config.*` → `<pm-exec> eslint .`; `biome.json(c)` → `<pm-exec> biome check .` |
| `verify.test` | **never detected** |
| `format.formatters` | `.prettierrc*` / `prettier.config.*` / a `prettier` key in `package.json` → prettier; else `biome.json(c)` → biome; plus `go.mod` → `gofmt -w $FILE` |
| `lsp.servers` | binary on `$PATH` **and** the language marker present: `typescript-language-server` + tsconfig/package.json, `gopls` + `go.mod`, `rust-analyzer` + `Cargo.toml`, `pyright-langserver` (else `pylsp`) + `pyproject.toml`/`requirements.txt` |

The package manager comes from the lockfile (`bun.lock(b)`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`), defaulting to bun. Binaries run through the project's own `node_modules/.bin` (`bunx`, `pnpm exec`, `yarn exec`, `npx`) — a bare `tsc` or `prettier` is rarely on `$PATH` even as a devDependency.

Precedence, in order:

1. `autoDetect: false` disables all detection; explicit config still applies.
2. `enabled: false` on a block is an absolute veto — that block detects nothing.
3. Explicit config wins **per field**, not per block: setting only `verify.lint` still gets a detected `verify.typecheck`. `lsp.servers` merges per language key; `format.formatters`, being one map, is replaced wholesale when set.
4. `enabled` resolves true when set true, or when unset and at least one command/formatter/server resolved.

`test` is never detected on purpose: a suite is slow, and one pre-existing failure would trap the model in the verify loop for two extra turns on every chain, forever. It runs only when the user names the command.

`/doctor` and `/status` print the effective values, each tagged `(configured)` or `(detected)`; `/doctor` also says when `autoDetect` is off. `src/lsp/availability.ts` is the odd caller — `listTools()` has no context, so it reads the raw config file and resolves the project root itself (`resolveProjectRoot()`), once per process.

## Notes

- `performance-findings.txt` at root is a temporary analysis doc — not part of the build.
- `scripts/install.sh` is the macOS-only local-dev installer. Cross-platform release binaries come from `scripts/release.sh`.
- Default model is `~google/gemini-flash-latest` via OpenRouter. Default `compact.threshold` is 0.5.
- Subagents run in-process (no sandboxing), write sidechain transcripts under `<sessionDir>/sidechains/`, and return a single summary string to the parent.
- Self-update: `ye --update`. Background check on launch surfaces in the status bar.
- Ctrl+C cancels reverse-search, then clears input, then aborts the stream — never exits. Use `/exit` to quit.
- Key bindings: Shift+Tab cycles mode, Ctrl+O toggles tool-call group expansion, Ctrl+G composes the buffer in `$VISUAL`/`$EDITOR`, Ctrl+R searches cross-session prompt history. `!cmd` runs a one-off shell command, `@` opens the file-mention picker.
- Prompt suggestions (`suggestions.enabled`, `src/suggest/`): after a clean chain, one predicted next prompt is generated on the cheap model with reasoning forced off, capped at 24 tokens, and shown as dim ghost text in an empty input. Tab or Right accepts it into the buffer without submitting; any keystroke, Esc, or a paste dismisses it. Tab precedence is mention accept → command completion → suggestion accept, so it can never shadow the pickers. Generation is fire-and-forget and fails silently — a failed suggestion must never surface an error.
- `patch-stdin.ts` rewrites Kitty/modifyOtherKeys sequences for Ink. Its terminal write is guarded by `isTTY` — unguarded, it prefixed piped `--help`/`--version`/`-p` output with a raw escape.
