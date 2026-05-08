# Ye — Skills

A **skill** is a SKILL.md file containing a procedural recipe for the model: "when the task looks like X, follow these instructions." Ye loads skill metadata at session start and lets the model invoke a skill body on demand. Skills are how you give Ye domain-specific knowledge without paying the per-turn token cost of stuffing it all into the system prompt.

The format is the open Agent Skills standard — the same SKILL.md works in Claude Code, Codex CLI, Cursor, Gemini CLI, and Copilot. A skill written for Ye is portable.

## What skills are (and are not)

Skills are **knowledge injection**, not sandboxes. A skill teaches the model to behave a certain way for a certain kind of task — it does not gate which tools the model is allowed to use. Tool gating is the permission system's job (`AUTO`/`NORMAL`/`PLAN` modes plus pattern rules in `~/.ye/config.json`); skills shouldn't reinvent that layer.

This shapes one concrete decision: **`allowed-tools` in skill frontmatter is parsed and ignored.** It exists in the open standard so SKILL.md files written for Claude Code keep working when copied into Ye, but Ye does not enforce it. If your skill body says "use Read for the audit, don't run Bash," write that in the body and trust the model to comply — the same way you trust it to comply with any system-prompt guidance. Don't reach for `allowed-tools` thinking it's a hard constraint here. It isn't.

## File layout

A skill is a directory containing a `SKILL.md` file:

```
<name>/
  SKILL.md
  scripts/      (optional — executable scripts the body asks the model to run)
  references/   (optional — long supporting docs the body asks the model to read)
  assets/       (optional — templates, fonts, binaries the body uses in output)
```

The directory name is the skill's identifier and slash command. The frontmatter `name` field must match the directory name; otherwise the skill is silently skipped at load time.

The `scripts/`, `references/`, and `assets/` subdirectories are conventional, not enforced. The model uses Read or Bash to access them when the SKILL.md body says to.

## SKILL.md structure

```markdown
---
name: my-skill
description: One-line description with explicit "use when..." triggers. The model only sees this until it actually invokes the skill.
disable-model-invocation: false
---

# My Skill

The body. Plain markdown. The model reads this verbatim when it calls Skill { command: "my-skill" }.

You can interpolate slash-command arguments into the body:

  - $0..$N       — positional args, shell-quoted
  - $ARGUMENTS   — full raw argument string, no quoting
```

### Frontmatter fields

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Lowercase letters, digits, hyphens. Max 64 chars. Must match the directory name. |
| `description` | yes | Max 1024 chars. The model's *only* signal for when to auto-invoke; be explicit, list trigger phrases. |
| `disable-model-invocation` | no | When `true`, the model cannot auto-invoke; only the user can fire it via slash. The skill is hidden from `<available_skills>`. Useful for skills that change destructive shared state (deploys, mass commits). |

Other fields commonly seen in the wild (`allowed-tools`, `model`, `version`, `user-invocable`, `metadata`) are accepted by the parser and ignored. They will not break loading; they do not affect Ye's behavior. Keep them in the file if you want the same SKILL.md to work in Claude Code or another agent that does enforce them.

### Body length

Aim for under ~500 lines. Anything longer should move to `references/some-doc.md` with the body instructing the model to read it on demand. The body counts against context every turn after invocation; references don't.

## Filesystem tiers

Ye walks five tiers at session start, in increasing priority:

1. **Builtin** — embedded in the binary at compile time. Today: `frontend-design` and `project-init`. Lowest priority — every other tier can shadow them by name.
2. **Managed** — `/etc/ye/skills/<name>/SKILL.md`. For multi-user installs.
3. **Claude interop** — `~/.claude/skills/<name>/SKILL.md`. Walked only when `skills.enableClaudeInterop: true` in `~/.ye/config.json`. Default off.
4. **User** — `~/.ye/skills/<name>/SKILL.md`. Personal, available across every project.
5. **Project** — `<project>/.ye/skills/<name>/SKILL.md`. Committed to git, shared with the team.

A skill is identified by its `name`. Higher tiers shadow lower tiers entirely — there is no merge inside a skill, the higher SKILL.md replaces the lower one.

### Overriding a builtin

Ye ships with `frontend-design` and `project-init`. Both are opinionated defaults that reflect the maintainer's stack. To override either:

```bash
mkdir -p ~/.ye/skills/frontend-design
$EDITOR ~/.ye/skills/frontend-design/SKILL.md
# Set frontmatter `name: frontend-design`. Whatever you write here replaces the builtin.
```

Per-project overrides go under `<project>/.ye/skills/`.

### Open-standard interop

To share skills with Claude Code (or any agent that reads `~/.claude/skills/`), set in `~/.ye/config.json`:

```json
{
  "skills": { "enableClaudeInterop": true }
}
```

Default off. When enabled, Ye walks `~/.claude/skills/` between the managed and user tiers — Ye-native user skills override Claude skills of the same name. The format is identical (open Agent Skills standard); the same SKILL.md works in both agents without modification.

## Invocation

There are two ways to invoke a skill:

### Slash command

Every loaded skill auto-binds to `/<name>`:

```
/frontend-design build a landing page for a fintech analytics product
```

Ye's built-in slash commands (`/help`, `/exit`, `/clear`, `/mode`, `/provider`, `/model`, `/resume`, `/rewind`, `/init`, `/copy`) always win on name conflict. A skill named `init` cannot shadow `/init`; the slash route is taken by the builtin and the skill stays reachable via the model-driven path below.

The slash invocation sends a hidden prompt instructing the model to call the Skill tool with the typed args. Same execution path either way.

### Model auto-invocation

The model sees `<available_skills>` in the description of the `Skill` tool — name plus description for every loaded skill that has not opted out via `disable-model-invocation: true`. When the user's task matches a skill's description, the model calls:

```
Skill { command: "frontend-design", args: "..." }
```

The Skill tool is read-only — invoking it never triggers a permission prompt in NORMAL mode. The body of the skill may instruct the model to call other tools (Edit, Bash, etc.); those go through the normal permission flow.

In PLAN mode, `Skill` is on the allowlist alongside Read/Glob/Grep — invoking a skill is a metadata load, exactly the kind of thing PLAN is meant to allow.

## Argument substitution

If the slash command (or model `args` payload) is `foo "bar baz" qux`:

- `$0` → `'foo'` (shell-quoted)
- `$1` → `'bar baz'` (shell-quoted, single quotes preserve the space)
- `$2` → `'qux'`
- `$3..$N` → empty string
- `$ARGUMENTS` → `foo "bar baz" qux` (verbatim, no quoting)

Use `$0..$N` when interpolating into a Bash command (the shell quoting is what you want). Use `$ARGUMENTS` when you want the user's raw input passed through to free-form prose.

## Writing good descriptions

The `description` is the *only* thing the model sees until it invokes the skill. A weak description means the model never reaches for the skill, no matter how good the body is.

Recommended pattern: state what the skill does, then list the conditions under which the model should trigger it. Be aggressive — Claude tends to under-trigger skills. Two patterns that work:

```yaml
description: Build frontend interfaces. Use whenever the user asks to build, style, redesign, or beautify any web UI. Trigger even when the user does not say "design", as long as the deliverable is rendered interface code.

description: Set up a new project. Use when the user says "new project", "init", "scaffold", "bootstrap", or asks for a starter, even when no stack is named.
```

Bad pattern:

```yaml
description: A skill for working with frontend code.
```

That description tells the model what category the skill belongs to but not when to use it. The model will skip it.

## Bundled skills

Ye ships with two:

- **`frontend-design`** — opinionated frontend stack guidance. MUI primary, Lucide icons, no Tailwind, no purple gradients, no glassmorphism, no emoji icons. Catches common LLM "vibecoded" tells before they ship.
- **`project-init`** — opinionated project bootstrapping. Vite/React/TypeScript on Bun for frontend, Laravel for PHP backends, plain `bun init` for Node libraries. SQLite default, nginx + Ubuntu LTS for deploys.

Both reflect the maintainer's stack. Both can be overridden by writing your own `~/.ye/skills/<name>/SKILL.md` with the same name. Both can be deleted from the model's surface entirely by writing an override with `disable-model-invocation: true`.

## Authoring workflow

1. Create the directory: `mkdir -p ~/.ye/skills/my-skill`
2. Write `~/.ye/skills/my-skill/SKILL.md` with frontmatter + body.
3. Restart Ye. The registry is loaded once per session — there is no hot-reload.
4. Verify by typing `/my-skill` and watching the model pick up the body.

## Installing from marketplaces (in-session)

The model is taught about skills in the system prompt, including a default list of marketplaces and how to install a skill on request. Ask Ye in plain English:

- "Install the markdown-formatter skill from anthropics/skills."
- "Find me a skill for writing Postgres migrations and install it."

The model uses WebFetch (or `gh` for GitHub repos) to grab the SKILL.md, validates it, and writes it under `~/.ye/skills/<name>/SKILL.md`. Restart Ye to load it.

Default marketplaces the model is told to consult, in order:

- `github.com/anthropics/skills` — official Anthropic-curated.
- `github.com/aiskillstore/marketplace` — security-audited.
- `github.com/VoltAgent/awesome-agent-skills` — large curated index.
- `claudeskills.info` — web marketplace.

You can name any other marketplace at runtime; the model honors what you specify.

## Authoring from a codebase pattern (in-session)

The model can also write a skill for you on the fly. Ask:

- "Remember how we handle database normalization in this codebase. Make a skill for it."
- "Make a skill that captures the API error-handling pattern we use."

Ye reads the relevant files, distills the pattern into a SKILL.md, and writes it to `<project>/.ye/skills/<name>/SKILL.md` (or `~/.ye/skills/` if you ask for personal scope). Restart Ye and the new skill is live.

## Roadmap (deferred, not rejected)

- **`ye skills` CLI.** `list / show / new <name>` subcommands for managing skills from outside a session. Pure convenience.
- **Subagent access.** The general subagent does not currently get the `Skill` tool. Skills can be added to the subagent toolset when a real use case appears.
- **`~/.claude/skills/` interop.** Walker not yet shipped; config flag `skills.enableClaudeInterop` reserved.
- **`disable-model-invocation: true` slash entry hiding.** Today, all skills appear in the slash picker. A future flag may hide such skills from `/<name>` discovery as well.
- **Hot reload.** Edit a SKILL.md mid-session, Ye won't notice until restart. Matches the `loadFileIndex` lifecycle.

## Explicitly not on the roadmap

- **Tool sandboxing via skills.** `allowed-tools` will not be enforced. Skills inject context; tool gating is the permission system's job. See "What skills are (and are not)" above.

## Implementation pointers

For maintainers:

| Concern | File |
|---|---|
| Types | `src/skills/types.ts` |
| Frontmatter parser | `src/skills/parse.ts` |
| Argument tokenizer + substitution | `src/skills/argv.ts` |
| Tier walker | `src/skills/walker.ts` |
| Builtin embedding (text imports) | `src/skills/builtin.ts` |
| Registry orchestration + tier merge | `src/skills/registry.ts` |
| `<available_skills>` description builder | `src/skills/description.ts` |
| Slash adapter | `src/skills/slashAdapter.ts` |
| Skill meta-tool | `src/tools/skill/index.ts` |
| Path conventions | `src/storage/skillsPaths.ts` |
| Wiring | `src/components/app.tsx` (registry load), `src/commands/index.ts` (slash registry), `src/permissions/modes.ts` (PLAN allowlist), `src/tools/registry.ts` (tool registration) |
| Bundled skill bodies | `src/skills/builtin/*.SKILL.md` |
