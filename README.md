# Ye

A local, open coding agent for the terminal. TypeScript on Bun, Ink TUI, multi-provider, all state on disk under `~/.ye/`.

An agent loop with deny-first permissions, append-only transcripts, and pluggable tools — built to be extended freely and run on whatever model you want.

## Install

Requires [Bun](https://bun.sh) and [ripgrep](https://github.com/BurntSushi/ripgrep) (`brew install ripgrep`).

**Prebuilt binaries** for macOS (arm64), Linux (x64), and Windows (x64) are attached to each [GitHub release](https://github.com/TimAnthonyAlexander/ye/releases). One-liner install scripts grab the latest release and drop `ye` onto your `$PATH`:

**macOS (arm64)**

```
curl -fsSL https://github.com/TimAnthonyAlexander/ye/releases/latest/download/ye-macos -o ye && chmod +x ye && sudo mv ye /usr/local/bin/ye
```

**Linux (x64)**

```
curl -fsSL https://github.com/TimAnthonyAlexander/ye/releases/latest/download/ye-linux -o ye && chmod +x ye && sudo mv ye /usr/local/bin/ye
```

**Windows (x64, PowerShell)**

```
$dest = "$env:LOCALAPPDATA\Programs\ye"; New-Item -ItemType Directory -Force $dest | Out-Null; Invoke-WebRequest https://github.com/TimAnthonyAlexander/ye/releases/latest/download/ye-windows.exe -OutFile "$dest\ye.exe"; [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$dest", "User")
```

Restart the shell after the Windows install so the updated `Path` takes effect.

**From source** (macOS local dev):

```
git clone <repo> ye && cd ye
bun install
./scripts/install.sh
```

The install script compiles a single binary via `bun build --compile` and symlinks `ye` into the first writable directory on `$PATH` (`~/.local/bin`, `~/bin`, or `/usr/local/bin`).

Set your provider key — by default Ye reads it from `OPENROUTER_API_KEY`:

```
export OPENROUTER_API_KEY=sk-or-...
```

The env var name is configurable in `~/.ye/config.json`, so you can run multiple keys side by side.

## Usage

```
ye
```

That's the whole thing. Ye opens an Ink session in the current directory, streams model output, and prompts for permission before any state-modifying tool call.

**Modes** — cycle with `Shift+Tab`:

- **NORMAL** — default. State-modifying tools fire a y/n prompt; read-only tools auto-allow.
- **AUTO** — every tool auto-allows. Useful for trusted projects and long runs. Bash has no sandbox yet, so use it carefully.
- **PLAN** — read-only. Only read-only tools plus `ExitPlanMode` are allowed. The model proposes a plan, you accept it, mode flips back to NORMAL. Plans are saved under `~/.ye/projects/<hash>/plans/` so you can revisit them later.

**Per-session override** — `ye --mode AUTO` (or `NORMAL` / `PLAN`).

**Project notes** — Ye reads `CLAUDE.md` if present in the project root, otherwise `YE.md`. One resolver, no surprises. Project memory and sessions live under `~/.ye/projects/<hash>/`, keyed by a stable 12-char hash of the project root.

## Tools

Fifteen built-in tools:

| Tool | What it does |
|------|--------------|
| **Read** | Read a file (default 2000 lines, `offset` + `limit` for slicing). Absolute paths only. |
| **Edit** | Exact-string replace. Requires a prior Read of same file. `replace_all` flag. |
| **Write** | Create or overwrite. If the file exists, prior Read is required. |
| **Bash** | Run a shell command via `sh -c`. 2-min default timeout, 15-min max. |
| **Grep** | Wraps `rg`. Three modes: content, files-with-matches, count. Type/glob filters. |
| **Glob** | File pattern match, sorted by mtime. Skips noise dirs (node_modules, .git, etc.). |
| **TodoWrite** | Lightweight task list. Exactly one `in_progress` at a time. |
| **Task** | Spawn an isolated subagent (explore or general). Sidechain transcript, summary returned. |
| **WebFetch** | Fetch URL, HTML→markdown, small-model summarise. 15-min cache. Cross-host redirect detection. |
| **WebSearch** | Search the web. Anthropic server-side, Brave, or DuckDuckGo fallback. Title + URL only. |
| **Skill** | Invoke a named user/project skill for specialised instructions. Read-only metadata load. |
| **SaveMemory** | Persist a memory note. Writes to project memory store, auto-selected in future sessions. |
| **AskUserQuestion** | Ask the user a structured 2-4 option question with an optional multi-select. |
| **EnterPlanMode** | Request a switch INTO PLAN mode. Triggers a permission prompt. |
| **ExitPlanMode** | Write plan and prompt to leave PLAN mode. Only state-modifying tool allowed in PLAN. |

Read-only tools (Read, Grep, Glob, WebFetch, WebSearch, Skill, AskUserQuestion) auto-allow in NORMAL mode. Everything else prompts.

## Providers

One canonical `Provider` interface; vendor differences live behind it. Tool-call format normalization happens in the provider module — the rest of Ye never sees vendor-shaped data.

- **OpenRouter** — default. Streams via SSE, OpenAI-compatible tool calls, context window discovered via the `/models` endpoint.
- **Anthropic direct** — native tool-use blocks, prompt caching at the static/dynamic boundary. Uses `ANTHROPIC_API_KEY`.
- **OpenAI** — latest **Responses API v1** (GPT-4.1/5 family). Interleaved reasoning & strict schema. Uses `OPENAI_API_KEY`.

Set the active provider and model in `~/.ye/config.json`. Switching providers is one config change, no other code touches it.

## Configuration

`~/.ye/config.json` controls the default provider, default model, permission rules, the auto-compact threshold (default 50% of the context window), and the env-var name to read each provider's key from. Permission rules use a small glob — `Bash(rm:*)` style — and deny always overrides allow.

## Memory & sessions

Everything Ye writes lives under `~/.ye/`:

- **Notes hierarchy** — managed (`/etc/ye/CLAUDE.md`) → user (`~/.ye/CLAUDE.md`) → project (`CLAUDE.md` or `YE.md`) → local (`YE.local.md`, gitignored). Concatenated into context in order.
- **Auto-memory** — LLM-based selection of relevant memory files at turn start. No embeddings, no vector DB. Plain Markdown, version-controllable.
- **Sessions** — append-only JSONL per session under `~/.ye/projects/<hash>/sessions/`. One event per line; replays are exact.
- **Plans** — saved as `<word>-<word>.md` for memorability.
- **Cross-session prompt history** — `~/.ye/history.jsonl`, scrollable with up-arrow.

Disk is never destructively edited. Compaction records boundary markers and patches the chain at load time; the original transcript stays intact.

## Subagents

Ye's defense against context blowup. Subagents run the same pipeline with isolated state, write their own sidechain transcript, and return a single summary string to the parent — full subagent history never enters parent context.

- **Explore** — codebase search, read-only (Read/Glob/Grep). Takes a `thoroughness` param (`quick` / `medium` / `very_thorough`).
- **General** — full toolset, runs in AUTO mode. Spawned via the Task tool with `kind: "general"`.

## Skills

Skills are pre-written procedural recipes that extend Ye's behavior for specialised tasks — frontend design conventions, release workflows, language-specific patterns. They live as markdown files under `~/.ye/skills/` (per-user) or `.ye/skills/` (per-project, committed to git). Ye ships with built-in skills and consumes externally-authored ones from GitHub marketplaces. Installing a skill copies its SKILL.md and supporting files into the skills directory; a restart loads it into the registry.

---

**Status:** Ye is a work in progress. The design described above reflects the target end state per [`docs/`](./docs/). Many subsystems are partially implemented or still on the roadmap — see each doc's checklist for the current state.
