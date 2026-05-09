# Ye — Storage

Everything Ye writes to disk lives under `~/.ye/`. Everything Ye reads about a project (notes file, project memory) is resolved through one place — the central resolver — so resolution rules live in exactly one file. **No other module decides between `CLAUDE.md` and `YE.md`.**

This doc covers the on-disk layout, the canonical project resolver, the notes-file resolver, session/history transcripts, and the memory system. They're grouped here because they all live under `~/.ye/` and are interconnected: project hash → project folder → notes file → memory → sessions.

## Layout

```
~/.ye/
├── config.json                  # global config (already exists)
├── CLAUDE.md                    # user-level notes (Phase 2)
├── MEMORY.md                    # global memory index (Phase 2)
├── memory/                      # global memory files referenced by MEMORY.md (Phase 2)
├── history.jsonl                # cross-session prompt history (Phase 4)
├── usage.jsonl                  # per-call USD cost + token counts (append-only)
├── projects/
│   └── <projectHash>/
│       ├── meta.json            # original cwd, created_at, last_seen_at
│       ├── memory/              # per-project memory files (Phase 2)
│       ├── plans/               # PLAN-mode artifacts; persist by design
│       │   └── <word>-<word>.md
│       ├── sessions/
│       │   ├── <sessionId>.jsonl
│       │   └── <sessionId>/sidechains/<subId>.jsonl   # Phase 2
│       └── checkpoints/         # file-history (Phase 4)
```

## Project hash

`projectHash` = first 12 hex chars of sha256 of the canonical absolute path to the **project root**.

**Project root** = nearest ancestor directory that contains any of: `.git`, `package.json`, `composer.json`, `CLAUDE.md`, `YE.md`. Falls back to `cwd` if none found. (Cargo / pyproject / go.mod intentionally excluded — KISS, add only when a real project demands it.)

Stability over uniqueness — collisions at 12 hex chars are negligible, and a stable folder name beats a long opaque one. `meta.json` records the original path so a manual disambiguation is always possible.

Centralized in `src/storage/project.ts`. **Every other module asks `getProjectId()`; nobody re-implements the rule.**

## Notes file resolver — THE centralizer

The single most important rule in Ye:

> If the project root contains `CLAUDE.md`, that's the project notes file. Otherwise, `YE.md` is. If neither exists and Ye needs to write project notes, it creates `YE.md`.

Implemented as `getProjectNotesFile(projectRoot): { path: string; existed: boolean; format: "claude" | "ye" }` in `src/memory/notesFile.ts`. **Every read or write of project notes routes through it. No exceptions, no inline `fs.exists("CLAUDE.md")` calls.**

Reasoning: `CLAUDE.md` is already the de-facto convention for many existing repos. Ye respects it where it exists. Where it doesn't, Ye uses its own filename so it doesn't squat on a name that may later collide with Claude Code itself in shared environments.

`format` is exposed so callers can render with the right header (`# CLAUDE.md` vs `# YE.md`) without re-deriving the decision.

### Notes file: write triggers

Three triggers cause a write to the project notes file. All three route through `notesFile.ts` and require permission unless the active mode covers it (AUTO auto-allows; NORMAL prompts; PLAN denies):

1. **`/init` slash command (Phase 2).** User-initiated. Bootstraps the file with project conventions, scanning the repo for context.
2. **User-told update.** User says "save that to CLAUDE.md / YE.md / project notes" in chat. Model writes via Edit/Write — the resolver decides which file.
3. **Model-self-update on inconsistency.** When the model notices an outdated rule or contradicts the notes file mid-task, it proposes the update and writes via Edit. Same permission flow.

No fourth path. Anything writing to the notes file goes through one of these three with permission.

## Plans directory

PLAN mode (see PERMISSIONS.md) writes proposed plans to `~/.ye/projects/<hash>/plans/<word>-<word>.md`. Plans persist deliberately, so I can revisit and reuse one days later.

- **Path resolver:** `getProjectPlansDir(projectId): string` in `src/storage/paths.ts`. Single source. No literal `~/.ye/...plans/...` paths in any other module.
- **Filename:** two random English words joined by a dash. Cheap memorability over UUIDs. Wordlist lives in `src/storage/wordlist.ts` (small bundled list of common nouns + adjectives, picked with `Math.random()`).
- **Persistence on denial:** the `ExitPlanMode` tool writes the file *before* the permission prompt fires. If the user denies the mode flip, the plan stays on disk as an orphan — that matches the "plans persist" intent. Cleanup is manual (or a Phase 4+ pruner).

## CLAUDE.md hierarchy (Phase 2)

Same 4-level model as Claude Code, with one collision-avoidance change at the local level:

| Level | Path | Scope |
|-------|------|-------|
| Managed | `/etc/ye/CLAUDE.md` | System-wide (rare; for shared machines) |
| User | `~/.ye/CLAUDE.md` | Per user |
| Project | `<root>/CLAUDE.md` or `<root>/YE.md` (resolved via `notesFile.ts`) | Per project |
| Local | `<root>/YE.local.md` | Personal, gitignored |

Local file is always `YE.local.md` regardless of which format the project file uses, to avoid collision with `CLAUDE.local.md` if a user later installs Claude Code in the same repo.

Levels are concatenated in order, with delimiters, in step 3 of the pipeline (context assembly). The delimiter format is documented in `memory/hierarchy.ts` and used nowhere else.

## MEMORY.md (Phase 2)

Global `~/.ye/MEMORY.md` is an *index*, not memory itself: one-line entries pointing at memory files in `~/.ye/memory/`. Same model as Claude Code's auto-memory.

Per-project memory mirrors this under `~/.ye/projects/<hash>/memory/` with its own `MEMORY.md` (or starts as a flat folder; the index is added when the per-project memory grows).

Auto-memory retrieval (Phase 2) is an LLM-based scan of memory-file headers, top-N relevant (≤ 5). **No embeddings. No vector DB.** Files are inspectable, editable, version-controllable.

## Session JSONL transcript

One file per session, append-only, JSONL: `~/.ye/projects/<hash>/sessions/<sessionId>.jsonl`. One line per *event* (not per message). Events use the same shape as the pipeline's stream events — easier to replay.

Compaction (Phase 4) records `headUuid`, `anchorUuid`, `tailUuid` on a "compact boundary" event. Reading patches the chain at load time. **Disk is never destructively edited.**

## Cross-session prompt history (Phase 4 — shipped)

`~/.ye/history.jsonl`, append-only, one line per user prompt. Up-arrow in the UI scans backwards.

## Checkpoints (Phase 4 — shipped)

For `/rewind`-style rollbacks. Edit and Write call `checkpointFile()` before
mutating; the original content is copied into
`~/.ye/projects/<hash>/checkpoints/<sessionId>/<globalTurnIndex>/file-N.snap`,
indexed by a per-turn `manifest.json`. A `null` snapshot name signals "file did
not exist before this turn" — `/rewind` deletes those files instead of
restoring them.

The turn id used here is the **session-monotonic** `state.globalTurnIndex`,
not queryLoop's per-prompt `turnIndex`. Per-prompt indexing would collide
across user prompts and silently drop checkpoints (the dedup-by-path inside a
manifest would skip later turns' originals). globalTurnIndex bumps once per
runTurn invocation across the whole session and resumes from `maxGlobalTurnIndex`
on session resume so post-resume edits don't write into already-occupied
checkpoint dirs.

## Resume (Phase 4 — shipped)

`ye --resume [<sessionId>]` and `/resume` both project the session JSONL back
into a `Message[]` history via `replaySessionFile()`. The handle reopens the
existing JSONL in append mode (`openExistingSession`) — the resumed
conversation continues writing to the same transcript. Permissions are NOT
restored: re-prompt always, by hard rule (PERMISSIONS.md §"Future-proofing").

Replay also extracts:
- `prompts[]`: `(ordinal, firstTurnGlobalIdx, preview, ts, historyIdx)` per
  user prompt — used by `/rewind`'s picker.
- `maxGlobalTurnIndex`: highest globalTurnIndex observed; restored into
  `state.globalTurnIndex` so subsequent checkpoints don't collide.
- `mode`: last-seen mode change (replay only — permissions never restore).

## Rewind (Phase 4 — shipped)

`/rewind` opens a picker over the current session's prompts. On selection it
calls `rewindToTurn(projectId, sessionId, firstTurnGlobalIdx)` to restore
files (walks turn checkpoints in reverse, applying each manifest), truncates
`state.history` at the chosen prompt's `historyIdx`, and appends a `rewind`
event to the JSONL: `{type: "rewind", upToPrompt, firstTurnGlobalIdx}`.

The append-only invariant is preserved — the marker is honored at read-time
by `replaySessionFile`, which discards events from the rewound prompt onward.
A future `/resume` of the same session sees the post-rewind state.

## Files

```
src/storage/
├── index.ts            # public API
├── paths.ts            # ~/.ye paths (extends config/paths); getProjectPlansDir, getProjectMemoryDir, etc.
├── project.ts          # canonicalize cwd → project root → hash → folder layout
├── session.ts          # open/append/close session JSONL transcript
├── wordlist.ts         # bundled noun/adjective list for plan filenames
├── history.ts          # cross-session prompt history (Phase 4)
└── checkpoints.ts      # file-history snapshots (Phase 4)

src/memory/
├── index.ts
├── notesFile.ts        # the CLAUDE.md/YE.md resolver — THE centralizer
├── hierarchy.ts        # 4-level concat (Phase 2)
├── memoryIndex.ts      # MEMORY.md parsing (Phase 2)
└── select.ts           # auto-memory LLM-based selection (Phase 2)
```

## Decisions made

- **Project root detection by ancestor markers, not user config.** `cd` into a subdirectory and Ye still finds the same project.
- **Project hash is short and stable, not unique-by-construction.** 12 hex chars. `meta.json` records the original path for disambiguation if a collision ever happens.
- **One resolver function for project notes.** No code outside `notesFile.ts` decides between `CLAUDE.md` and `YE.md`. Lint-enforceable.
- **No SQLite, no vector DB, no Redis.** Plain files, JSONL, JSON config. Inspectable, editable, version-controllable. (Same call Claude Code made.)
- **One event per JSONL line, not one message.** Replays are exact, including tool execution timing and permission decisions.
- **Compaction never destructively edits disk.** Boundary records + load-time chain patching. Original transcript stays intact.

## Checklist

### Phase 1 — Storage foundation
- [x] `paths.ts` — `~/.ye`, `~/.ye/projects`, plus per-project path builders: `getProjectMemoryDir`, `getProjectSessionsDir`, `getProjectPlansDir`, `getProjectMetaPath`
- [x] `project.ts` — `canonicalize(cwd)` → project root (ancestor markers `.git`/`package.json`/`composer.json`/`CLAUDE.md`/`YE.md`) → 12-char sha256 hash → folder layout. Single exported function `getProjectId()`.
- [x] `notesFile.ts` — `getProjectNotesFile(root)` returns `CLAUDE.md` or `YE.md` per the rule. Single source of truth. Includes `existed` and `format` fields.
- [x] `session.ts` — `openSession()`, `appendEvent(event)`, `closeSession()` over an append-only JSONL handle
- [x] `wordlist.ts` — small bundled list of nouns + adjectives; export `randomPlanName(): string` returning `<word>-<word>`
- [x] `getProjectPlansDir(projectId)` ensures the directory exists on first call (lazy)
- [x] `meta.json` written on first project visit; `last_seen_at` bumped each session
- [x] Smoke test: from cwd inside a temp git repo, `getProjectId()` is stable across calls; `getProjectId()` from a subdirectory returns the same id; sessions land in `~/.ye/projects/<hash>/sessions/`
- [x] Smoke test: `getProjectId()` resolves correctly in a `composer.json`-only directory (PHP project)
- [x] Smoke test: `getProjectNotesFile()` returns `CLAUDE.md` when present, `YE.md` otherwise; `existed: false` when neither exists
- [x] Smoke test: `randomPlanName()` produces two-word filenames; collision rate acceptable for our scale (no on-disk dedupe in v1)

### Phase 2 — Memory hierarchy
- [x] `hierarchy.ts` — concat managed/user/project/local notes in order, with delimiters defined in this file only
- [x] `~/.ye/CLAUDE.md` recognized at user level; `<root>/YE.local.md` at local level
- [x] `memoryIndex.ts` — parse MEMORY.md as a list of `{ path, hook }` entries
- [x] `select.ts` — auto-memory: list memory-file headers, ask the model to pick top-N (≤ 5)
- [ ] Per-project memory directory created on first write (no first-write path yet — Ye only reads memory; defer until a memory.save tool exists)
- [x] Pipeline step 3 (assemble) calls `hierarchy.read()` and `select.run()`; no other call sites

### Phase 4 — History + checkpoints + resume
- [x] `history.ts` — append on each prompt; reverse-read for Up-arrow
- [x] `checkpoints.ts` — file snapshots at change boundaries; `checkpointFile`, `listSessionCheckpoints`, `rewindToTurn`. Uses session-monotonic `globalTurnIndex` so per-prompt turnIndex collisions don't drop captures
- [x] `replay.ts` — `replaySessionFile()` projects events back to `Message[]`, extracts prompt boundaries and `maxGlobalTurnIndex`; `listProjectSessions()` for the resume picker
- [x] `openExistingSession()` — append-mode handle for the resumed JSONL
- [x] `ye --resume [<sessionId>]` flag + `/resume` slash command (permissions NOT restored — hard rule)
- [x] `/rewind` slash command — files via `rewindToTurn`, history via append-only `rewind` marker honored at replay time
- [ ] Compact-boundary events on session JSONL; load-time chain patching in `session.ts` (Phase 4.5; needs message UUIDs)
