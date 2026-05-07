# Ye — Permissions

Permissions decide whether to run a tool the model asked for. v1 has the simplest workable design: two modes, deny-first rules, interactive y/n prompt. The full Claude Code design (7 modes, ML auto-classifier, 7 safety layers, hooks) is documented as the target — the v1 code structure leaves room for it without rewriting.

## v1 modes

| Mode | Behavior |
|------|----------|
| `default` | Ask the user y/n for any state-modifying tool call. Read-only tools (`readOnlyHint: true`) auto-allow. |
| `acceptAll` | All tool calls auto-allow. No prompts. Yolo. |

Mode is set per-session, defaults to `default`. Selected at startup via flag (`--mode acceptAll`) or in-session via slash command (`/mode`, Phase 2).

## v1 rule format

```ts
type Rule = {
  effect: "allow" | "deny";
  tool: string;            // exact tool name, e.g. "Bash"
  pattern?: string;        // tool-specific, e.g. "Bash(rm:*)"
};
```

Rules live in `~/.ye/config.json` under `permissions.rules`. Pattern syntax is a minimal glob — documented in this doc, not invented in two places. v1 supports:

- `Tool` — matches any call to `Tool` (no pattern) → blanket rule.
- `Tool(prefix:*)` — matches tool calls whose first argument string starts with `prefix:`.

That's it for v1. Richer matching is Phase 2.

## Evaluation order

1. **Pre-filter** — any tool with a blanket deny (`{ effect: "deny", tool: "X" }` with no pattern) is removed from the tool pool in `assembleToolPool` (step 6). The model never sees it.
2. **Pattern denies** — for each tool call, walk deny rules with patterns. First match wins → blocked.
3. **Pattern allows** — walk allow rules with patterns. First match wins → granted.
4. **Mode default** — `default` → prompt; `acceptAll` → granted.

Deny always overrides allow. Strictest wins. (Same rule as Claude Code.)

## Interactive prompt (`default` mode)

Rendered by the UI when the pipeline emits `permission.prompt`. Three options:

- **Allow once** — this call only.
- **Allow for the session** — appends a session-scoped allow rule (in memory; not written to disk).
- **Deny** — returns a `ToolResult` with `error: "user denied"`. The loop continues; the model sees the denial and decides what to do.

No "always allow" written to disk in v1. Disk writes during a session feel like a footgun; revisit once Ye has more usage data.

## Future-proofing for full mode set (Phase 5+)

The permission handler is a single function `decide(toolCall, ctx) → Decision`. v1's implementation has two branches (`default`, `acceptAll`). The full design adds branches for `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `bubble` — same function signature, no caller changes.

The auto-mode ML classifier (Claude Code's `yoloClassifier.ts`) is a separate file behind a feature flag; v1 does not include it but the seam is `decide()` itself.

The 7 safety layers are mostly orthogonal — each is a middleware step. v1 has 3 of the 7:
1. Tool pre-filtering ✓
2. Deny-first rule eval ✓
3. Permission mode constraints ✓
4. Auto-mode ML classifier (Phase 5)
5. Shell sandboxing (Phase 5)
6. Non-restoration on resume (Phase 4 — when resume exists, layer is automatic)
7. Hook-based interception (Phase 5)

## Files

```
src/permissions/
├── index.ts            # public API: decide()
├── modes.ts            # per-mode default behavior
├── rules.ts            # rule eval (deny-first, pattern matching)
├── prompt.ts           # prompt event payload + decision response shape
└── types.ts            # Decision, Rule, Mode
```

## Decisions made

- **No "always allow" written to disk in v1.** Session-scoped allow rules are in-memory only. They die with the process.
- **Permissions are not restored on resume.** Layer 6 from the Claude Code design — auditability over query power. Re-prompt on resume; don't trust the previous session.
- **Read-only tools (`readOnlyHint: true`) auto-allow in `default`.** A Read should never need a prompt.
- **`decide()` is the single decision function.** No mode logic anywhere else.
- **Rule pattern syntax is documented in one place** — this doc — and parsed in `rules.ts`. Patterns never get reinvented in tool implementations.

## Checklist

### Phase 1 — Two-mode permissions
- [ ] `types.ts` — Mode, Rule, Decision (allow/deny/prompt), ToolCall (canonical shape)
- [ ] `modes.ts` — `default` + `acceptAll` mode handlers
- [ ] `rules.ts` — deny-first evaluator with v1 pattern matching (`Tool` and `Tool(prefix:*)`)
- [ ] `index.ts` — `decide(toolCall, ctx)` entrypoint
- [ ] `prompt.ts` — declares the prompt event payload + `respond(decision)` response shape; UI implements rendering
- [ ] Pipeline step 7 wired to `decide()`
- [ ] Pipeline step 6 (tool pool assembly) drops blanket-deny tools before the model sees them
- [ ] Read-only tools (`readOnlyHint: true`) auto-allow in `default` mode
- [ ] CLI flag `--mode acceptAll` passes through to session settings
- [ ] Smoke test: a Bash call in `default` mode prompts; allow proceeds; deny returns a denial result and the loop continues

### Phase 2 — Slash command + session-scoped allows
- [ ] `/mode <name>` slash command (default ↔ acceptAll)
- [ ] "Allow for session" appends an in-memory rule that lives until process exit

### Phase 5 — Full mode set + safety layers
- [ ] Add `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `bubble` branches in `decide()`
- [ ] Auto-classifier in `auto` mode (separate LLM call; behind a feature flag)
- [ ] Hook integration: PreToolUse hooks may return `permissionDecision`
- [ ] Bash sandboxing layer (filesystem / network)
- [ ] Subagent permission override rule: subagent `permissionMode` applies UNLESS parent is in `bypassPermissions`/`acceptEdits`/`auto` (explicit user decisions take precedence)
