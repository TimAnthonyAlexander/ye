# Ye — Subagents

Subagents are Ye's defense against context blowup. They run the **same pipeline** with their own state, write their own JSONL, and return a *summary* to the parent — not their full transcript.

Definitely v2 territory. This doc is the design so Phase 2 is a thin step, not a rewrite.

## Built-in types

Phase 2 minimum: **Explore, General-purpose**. Others come in Phase 3 (Verification, likely earlier than originally planned) and Phase 5 (Statusline-setup, custom agents).

| Type | Purpose | Tools | Phase |
|------|---------|-------|-------|
| Explore | Codebase search/exploration. Read-only. | Read, Glob, Grep | 2 |
| General-purpose | Multi-step research / open-ended task. | Read, Glob, Grep, Edit, Write, Bash (configurable) | 2 |
| Verification | Verifies completion against the original plan. Adversarial — does not trust the implementer. | depends | likely 3 (was 5; expected to want it earlier) |
| Statusline-setup | Help configure Ye's status line. | minimal | 5 |
| Custom | `.ye/agents/*.md` with YAML frontmatter — same shape as Claude Code's `.claude/agents/`. | per-frontmatter | 5 (low priority — solo project) |

> **PLAN-the-mode lives in `src/permissions/`. Plan-the-subagent is intentionally absent.** Planning is the user's primary mode flip via Shift+Tab; a separate Plan subagent preset would duplicate that responsibility with a worse UX.

Explore takes a `thoroughness` param: `quick` | `medium` | `very thorough`. Maps to a per-Explore max-turns budget *within* the global `maxTurns.subagent` cap (e.g., 5 / 15 / 25).

## Isolation modes

| Mode | Mechanism | Phase | Default |
|------|-----------|-------|---------|
| In-process | Shared filesystem, isolated conversation | Phase 2 | yes |
| Worktree | Git worktree (filesystem isolation) | Phase 5 | no |
| Remote | Remote execution | deferred | no |

In-process is enough for most tasks. Worktree-mode is the right call when an agent does destructive edits we want to throw away.

## Spawn → run → return contract

1. Parent's pipeline emits a `Task` tool call with `{ type, prompt, options }`.
2. Storage opens a *sidechain* JSONL: `~/.ye/projects/<hash>/sessions/<parentId>/sidechains/<subId>.jsonl`.
3. A new pipeline runs with the subagent's own settings, tools, context, and abort signal.
4. On completion: subagent returns a single string (its final assistant text). The parent gets that string as the `Task` tool result. **Full subagent history never enters parent context.** This is the whole point.

## Coordination

When (Phase 5) we have multiple subagents in flight, file-locking via POSIX `flock` keeps state safe. Phase 2 is single-subagent-at-a-time and doesn't need it.

## Recursion guard

Subagents cannot spawn subagents in Phase 2. Stays simple, prevents loops. Phase 5 may relax this with an explicit depth budget (max 2 levels).

## SkillTool vs Subagent (the cost line)

| | Context cost | When |
|--|--------------|-------|
| Skill (Phase 5) | Low — instructions injected into current context | When the task is about *how* to do something the parent should do |
| Subagent (Phase 2) | High — new context window, ~7× tokens for agent teams | When the task should *not* pollute parent context |

Stated explicitly so future-Ye doesn't reach for the subagent when a Skill would do.

## Permission override rule (Phase 5)

Subagent `permissionMode` applies UNLESS parent is in `bypassPermissions`/`acceptEdits`/`auto`. Explicit user decisions always take precedence. (Same rule as Claude Code.) Phase 2 is simpler: subagent inherits parent's mode.

## Files

```
src/subagents/                  # Phase 2
├── index.ts                    # public API: spawn(), wait(), abort()
├── types.ts                    # SubagentSpec, SubagentResult
├── kinds/
│   ├── explore.ts              # tools, base prompt, thoroughness levels
│   └── general.ts
├── isolate/
│   ├── inProcess.ts
│   └── worktree.ts             # Phase 5
└── sidechain.ts                # sidechain JSONL writer (uses storage.session under the hood)
```

The `Task` tool lives in `src/tools/task/` — wire-only, calls into `subagents.spawn()`. No subagent logic in the tool.

## Decisions made

- **Subagents reuse the pipeline.** No parallel implementation. The same `queryLoop` runs with a different `TurnState` seed (different tools, transcript handle, system prompt slice).
- **Sidechain transcripts live under the parent's session folder.** Easy to find, easy to clean up, parent transcript references the sidechain ids.
- **Return value is a string.** Not structured data. The parent's loop sees the same shape it sees from any other tool. Structured returns are a Phase 5+ thing if ever.
- **No subagent-spawns-subagent in Phase 2.** Simpler, prevents loops. Revisit only if a real use case appears.
- **Permission inheritance in Phase 2 is "inherit parent's mode".** Custom agent `permissionMode` overrides come in Phase 5 with the full mode set.

## Checklist

### Phase 2 — Subagents v1
- [ ] `types.ts` — SubagentSpec, SubagentResult (single summary string)
- [ ] `sidechain.ts` — sidechain JSONL writer (delegates to `storage.session` for the file handle)
- [ ] `inProcess.ts` — runs `queryLoop` with isolated state, tools, abort signal, transcript handle
- [ ] `kinds/explore.ts` — Explore prompt, tool set (Read/Glob/Grep), thoroughness param mapping to max-turns inside the `maxTurns.subagent` cap
- [ ] `kinds/general.ts` — General-purpose prompt, configurable tool set
- [ ] Tool: `Task` (in `src/tools/task/`) — thin wire to `subagents.spawn()`; no logic
- [ ] `index.ts` — `spawn()`, `wait()`, `abort()`
- [ ] Recursion guard: subagent context flag prevents nested `Task` calls
- [ ] Subagent inherits parent's permission mode in Phase 2
- [ ] Smoke test: parent runs Explore against the Ye repo, gets a non-empty summary; parent's pre-Task vs post-Task message count differs only by the single Task tool result (no leaked sidechain history)

### Phase 3 — Verification (likely-earlier-than-Phase-5)
- [ ] `kinds/verification.ts` — adversarial verifier; ships with the anti-skipping prompt (see Phase 5 row in design)
- [ ] Wire Verification into the `Task` tool's allowed types

### Phase 5 — Worktree + custom agents + statusline-setup
- [ ] `worktree.ts` — git worktree setup/teardown, auto-cleanup if no changes were made
- [ ] `.ye/agents/*.md` parser (YAML frontmatter: tools, model, permissionMode, hooks, maxTurns, isolation, etc.) — low priority for solo project
- [ ] `kinds/statuslineSetup.ts`
- [ ] POSIX `flock`-based coordination for multi-subagent runs
- [ ] Permission override rule: subagent mode applies unless parent is in `bypassPermissions`/`acceptEdits`/`auto`
- [ ] Recursion: allow up to depth 2 with an explicit budget
- [ ] Anti-skipping prompt baked into the Verification kind (already shipped Phase 3):
  > "You will feel the urge to skip checks. … Run it."
