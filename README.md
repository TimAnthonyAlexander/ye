# Ye

A local, open coding agent for the terminal. TypeScript on Bun, Ink TUI, multi-provider, all state on disk under `~/.ye/`.

An agent loop with deny-first permissions, append-only transcripts, and pluggable tools — built to be extended freely and run on whatever model you want.

## Install

Requires [Bun](https://bun.sh) and [ripgrep](https://github.com/BurntSushi/ripgrep) (`brew install ripgrep`). macOS arm64/x64 for now; Linux and Windows land later.

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
- **PLAN** — read-only. Only Read, Glob, Grep, and `ExitPlanMode` are allowed. The model proposes a plan, you accept it, mode flips back to NORMAL. Plans are saved under `~/.ye/projects/<hash>/plans/` so you can revisit them later.

**Per-session override** — `ye --mode AUTO` (or `NORMAL` / `PLAN`).

**Project notes** — Ye reads `CLAUDE.md` if present in the project root, otherwise `YE.md`. One resolver, no surprises. Project memory and sessions live under `~/.ye/projects/<hash>/`, keyed by a stable 12-char hash of the project root.

## Tools

Eight built-in tools — enough for daily work:

| Tool | What it does |
|------|--------------|
| **Read** | Read a file (default 2000 lines, `offset` + `limit` for slicing). Absolute paths only. |
| **Edit** | Exact-string replace. Requires a prior Read of the same file in the turn. `replace_all` flag. |
| **Write** | Create or overwrite. If the file exists, prior Read is required. |
| **Bash** | Run a shell command. 2-min default timeout, 10-min max. |
| **Grep** | Wraps `rg`. Three modes: content, files-with-matches, count. |
| **Glob** | File pattern match, sorted by mtime. |
| **TodoWrite** | Lightweight task list. Exactly one `in_progress` at a time. |
| **ExitPlanMode** | Writes the proposed plan and prompts to leave PLAN mode. The only state-modifying tool allowed in PLAN. |

Read-only tools (Read, Grep, Glob) auto-allow in NORMAL mode. Everything else prompts.

## Providers

One canonical `Provider` interface; vendor differences live behind it. Tool-call format normalization happens in the provider module — the rest of Ye never sees vendor-shaped data.

- **OpenRouter** — default. Streams via SSE, OpenAI-compatible tool calls, context window discovered via the `/models` endpoint.
- **Anthropic direct** — native tool-use blocks, prompt caching at the static/dynamic boundary.
- **OpenAI** — standard chat completions.

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

- **Explore** — codebase search, read-only. Takes a `thoroughness` param (`quick` / `medium` / `very thorough`).
- **General-purpose** — open-ended multi-step research with a configurable tool set.
- **Verification** — adversarial completion check against the original plan.

Worktree isolation, custom agents (`.ye/agents/*.md`), and skills come later.

---

**Status:** Ye is a work in progress. The design described above reflects the target end state per [`docs/`](./docs/). Many subsystems are partially implemented or still on the roadmap — see each doc's checklist for the current state.
