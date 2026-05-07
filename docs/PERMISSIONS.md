# Ye — Permissions

Permissions decide whether to run a tool the model asked for. v1 ships with **three modes** (AUTO / NORMAL / PLAN), deny-first rule evaluation, and a single denial-message contract. The full Claude Code design (7 modes, ML auto-classifier, 7 safety layers, hooks) is the eventual target — the v1 code structure leaves seams for it without rewriting.

## v1 modes

| Mode | Behavior |
|------|----------|
| `AUTO` | All tool calls auto-allow. No prompts. Yolo. (Bash without sandbox in v1 — genuine "trust me".) |
| `NORMAL` | Default. State-modifying tools fire a y/n prompt. Read-only tools (`readOnlyHint: true`) auto-allow. |
| `PLAN` | Read-only mode for proposing plans. Read, Glob, Grep, and `ExitPlanMode` are allowed. **Every other tool is denied with a specific message** (see Denial-message contract). The model cannot escape PLAN mode by chat text — it must call `ExitPlanMode` with a proposed plan, which triggers a y/n prompt to flip mode. |

Default mode (`NORMAL`) is set in `src/config/defaults.ts`. Override per-session via `--mode <NAME>`. In-session via Shift+Tab.

## PLAN mode

PLAN exists to make planning the default workflow for non-trivial work, without trusting the model to "just plan first" via prose. The mode itself is the constraint.

- **Allowed tools:** Read, Glob, Grep, ExitPlanMode.
- **Denied tools:** Edit, Write, Bash, TodoWrite, and anything else state-modifying.
- **Denial message** (constant; from `src/permissions/messages.ts`):
  > Tool blocked: PLAN mode allows Read, Glob, Grep, ExitPlanMode only. Either call ExitPlanMode with a proposed plan, or stop and ask the user to switch modes via Shift+Tab.
- **ExitPlanMode flow:** the tool writes the proposed plan to `getProjectPlansDir(projectId)/<word>-<word>.md` and then fires a permission prompt asking the user to accept the plan and flip to NORMAL (or AUTO). On accept: mode flips, the loop continues with the new mode. On deny: mode stays PLAN, the plan file remains on disk (orphan plans are intentional; they persist for later reuse).
- **Loop guard.** The pipeline tracks consecutive denials of the same tool in PLAN mode. **Two in a row → terminate the turn** with a stop reason of `plan_loop_guard` and a message asking the user to switch modes. (Without this, a model that doesn't take the denial message seriously will spin trying to call Edit until max turns.)

## NORMAL mode prompt options

When NORMAL prompts on a state-modifying tool, the UI offers three choices:

- **Allow once** — this call only.
- **Allow for the session** — appends a session-scoped allow rule (in memory; not written to disk).
- **Deny** — returns a `ToolResult` with `error: "user denied"`. The loop continues; the model sees the denial and decides what to do.

No "always allow" written to disk in v1. Session-scoped allow rules die with the process. (Layer 6 from the Claude Code design — non-restoration on resume — is automatic in v1 for the same reason: there's nothing to restore.)

## AUTO mode

No prompts. Every tool call routes through deny-first rules and then auto-allows. Useful for trusted projects, throwaway sandboxes, and long-running runs where prompts would block. **Bash has no sandbox in v1**, so AUTO + Bash in an untrusted project is genuinely dangerous — the help text and the mode-flip UI flag this.

## Mode switching

Two paths into and out of any mode:

1. **Shift+Tab.** Always available, in any mode, in the Ink UI. Cycles `NORMAL → AUTO → PLAN → NORMAL`. The keybind lives in `src/ui/keybinds.ts` (single source). No keybind logic scattered across components.
2. **`ExitPlanMode` tool.** PLAN mode-specific. Model-initiated request to flip to NORMAL (with a proposed plan attached). User accepts/denies via the standard y/n prompt.

Phase 2 adds **`EnterPlanMode`** as the symmetric model-initiated path *into* PLAN mode (the user already has Shift+Tab from v1 — `EnterPlanMode` is the model's equivalent).

## v1 rule format

```ts
type Rule = {
  effect: "allow" | "deny";
  tool: string;            // exact tool name, e.g. "Bash"
  pattern?: string;        // tool-specific, e.g. "Bash(rm:*)"
};
```

Rules live in `~/.ye/config.json` under `permissions.rules`. Pattern syntax is a minimal glob — documented in this doc, parsed in `rules.ts`, **invented nowhere else**:

- `Tool` — matches any call to `Tool` (no pattern) → blanket rule.
- `Tool(prefix:*)` — matches tool calls whose first argument string starts with `prefix:`.

Richer matching is Phase 2.

## Evaluation order

1. **Mode-based pre-filter** — in PLAN mode, only the allowed-tools list reaches the model in step 6 of the pipeline. (Other modes don't pre-filter on mode.)
2. **Blanket-deny pre-filter** — any tool with a blanket deny is removed from the tool pool before the model sees it.
3. **Pattern denies** — for each tool call, walk deny rules with patterns. First match wins → blocked.
4. **Pattern allows** — walk allow rules with patterns. First match wins → granted.
5. **Mode default** — NORMAL: prompt for state-modifying tools, auto-allow for read-only; AUTO: granted; PLAN: deny with the constant message *unless* the tool is in PLAN's allow-list.

Deny always overrides allow. Strictest wins.

## Denial-message contract

A single `src/permissions/messages.ts` file owns all denial messages. Imported, not inlined. Two message kinds in v1:

- **User denial:** "User denied this action."
- **PLAN-mode block:** the constant text quoted under PLAN mode above.

Both are stable strings — the model can be relied on to pattern-match on them across turns. Adding a new denial reason adds a new constant; never inline a denial string anywhere else.

## Future-proofing for full mode set (Phase 5)

The permission handler is a single function `decide(toolCall, ctx) → Decision`. v1's implementation has three branches (`AUTO`, `NORMAL`, `PLAN`). Phase 5 adds **four** more branches (`acceptEdits`, `dontAsk`, `bypassPermissions`, `bubble`) — same function signature, no caller changes. Total: 7 modes.

The auto-mode ML classifier (Claude Code's `yoloClassifier.ts`) is a separate file behind a feature flag; v1 does not include it.

The 7 safety layers are mostly orthogonal — each is a middleware step. v1 has 4 of the 7:
1. Tool pre-filtering (mode-based + blanket-deny) ✓
2. Deny-first rule eval ✓
3. Permission mode constraints ✓
4. Auto-mode ML classifier (Phase 5)
5. Shell sandboxing (Phase 5)
6. Non-restoration on resume — automatic in v1 (no resume yet); becomes a real layer in Phase 4
7. Hook-based interception (Phase 5)

## Files

```
src/permissions/
├── index.ts            # public API: decide()
├── modes.ts            # per-mode default behavior (AUTO / NORMAL / PLAN)
├── rules.ts            # rule eval (deny-first, pattern matching)
├── messages.ts         # denial-message constants — single source of truth
├── prompt.ts           # prompt event payload + decision response shape
└── types.ts            # Decision, Rule, Mode
```

## Decisions made

- **Three modes in v1, not two.** PLAN is the meaningful new mode and it earns its place by enforcing read-only via *constraint*, not by trusting the model to behave.
- **Denial messages are constants in `messages.ts`.** No inlined strings. The PLAN-mode denial message is specific enough that the model can recover (call ExitPlanMode or stop and ask the user).
- **Loop guard on consecutive same-tool PLAN denials.** Two strikes → terminate the turn. Without this, max-turns is the only backstop; that's too late.
- **`ExitPlanMode` writes before it prompts.** Plan files persist by design — orphan plans on denial are a feature, not a bug. (See TOOLS.md for the full reasoning.)
- **Permissions are not restored on resume** (Phase 4). Re-prompt always.
- **`decide()` is the single decision function.** No mode logic anywhere else.
- **Rule pattern syntax is documented in one place** — this doc — and parsed in `rules.ts`. Patterns never get reinvented in tool implementations.

## Checklist

### Phase 1 — Three-mode permissions
- [x] `types.ts` — Mode (`"AUTO" | "NORMAL" | "PLAN"`), Rule, Decision (`allow` / `deny` / `prompt`), ToolCall (canonical shape)
- [x] `messages.ts` — denial-message constants (user-denied, PLAN-mode-blocked); no other file emits denial strings
- [x] `modes.ts` — AUTO + NORMAL + PLAN handlers; PLAN's allow-list (Read, Glob, Grep, ExitPlanMode) is data, not branches
- [x] `rules.ts` — deny-first evaluator with v1 pattern matching (`Tool` and `Tool(prefix:*)`)
- [x] `index.ts` — `decide(toolCall, ctx)` entrypoint
- [x] `prompt.ts` — declares the prompt event payload + `respond(decision)` response shape; UI implements rendering
- [x] Pipeline step 7 wired to `decide()`
- [x] Pipeline step 6 (tool pool assembly) drops blanket-deny tools and (in PLAN mode) tools not on PLAN's allow-list before the model sees them
- [x] Read-only tools (`readOnlyHint: true`) auto-allow in `NORMAL` mode
- [ ] CLI flag `--mode <AUTO|NORMAL|PLAN>` passes through to session settings
- [x] PLAN-mode denial returns the canonical message from `messages.ts`
- [x] Mode flip via `ExitPlanMode` tool: writes plan → prompts → on accept, mutates session mode; on deny, mode stays PLAN
- [x] Shift+Tab keybind in `src/ui/keybinds.ts` cycles NORMAL → AUTO → PLAN → NORMAL
- [x] Smoke test: a Bash call in NORMAL prompts; allow proceeds; deny returns the canonical user-denial result
- [x] Smoke test: an Edit call in PLAN returns the canonical PLAN-block message; a second consecutive Edit terminates the turn (loop guard — implemented in pipeline; this test exercises the contract)
- [ ] Smoke test: ExitPlanMode in PLAN, accept flow → mode is NORMAL afterwards; deny flow → mode is PLAN, plan file still on disk

### Phase 2 — Slash command + session-scoped allows + EnterPlanMode
- [x] `/mode [<name>]` slash command (NORMAL ↔ AUTO ↔ PLAN). Argless opens the interactive picker (filter-as-you-type, ↑↓, Enter, Esc) via `SlashCommandContext.pick`.
- [x] "Allow for session" appends an in-memory rule that lives until process exit
- [x] `EnterPlanMode` tool (model-initiated; symmetric to user's Shift+Tab into PLAN)

### Phase 5 — Full mode set + safety layers
- [ ] Add `acceptEdits`, `dontAsk`, `bypassPermissions`, `bubble` branches in `decide()` (4 more, total 7)
- [ ] Auto-classifier in a Phase-5 `auto` mode (separate LLM call; behind a feature flag)
- [ ] Hook integration: PreToolUse hooks may return `permissionDecision`
- [ ] Bash sandboxing layer (filesystem / network)
- [ ] Subagent permission override rule: subagent `permissionMode` applies UNLESS parent is in `bypassPermissions`/`acceptEdits`/the Phase-5 `auto` (explicit user decisions take precedence)
