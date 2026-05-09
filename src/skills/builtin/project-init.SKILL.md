---
name: project-init
description: Set up a new project with Tim's defaults. Use this skill whenever the user says "new project", "init", "scaffold", "bootstrap", "start fresh", or asks for a starter for a backend, frontend, CLI, or library, even when no stack is named. Also use when the user has an empty directory and wants something running in it.
allowed-tools: Read Glob Bash Write Edit
---

# Project Init

## Identify

If the user has told you what the project is, ask only what cannot be inferred. If the user said "React app", do not ask "frontend or backend"; pick. Package manager follows from runtime — Bun if the user has no preference.

If the user has NOT told you what the project is — they said "build me a website", "start a new project", "scaffold something", "make me an app" with no further detail — you do not have enough to scaffold. Ask 1–3 short, concrete questions about the load-bearing unknowns first: what is it (frontend page, full-stack app, CLI, library), what does it do, who is it for. The defaults below describe how to build *once* you know what you're building; they don't answer what to build. Don't pick the project type for the user just because Bun-React is your default — that's how vague briefs become wrong projects.

## Universal

- `git init` plus one initial commit at the end.
- `.editorconfig`: `indent_style = space`, `indent_size = 2`, `end_of_line = lf`, `insert_final_newline = true`, `charset = utf-8`.
- `.gitignore`: ten to twenty lines that actually apply to the runtime. Do not paste a 200-line GitHub template.
- `README.md`: three sections only. What it is. How to run. How to test. No file or folder tree. No emojis. No filler. If a section has nothing real to say, one line and move on.
- No LICENSE. Add only if the user explicitly asks.

## React frontend

- Vite. React Router. TypeScript. Bun: `bun create vite`, `bun install`, `bun run dev`.
- `tsconfig.json`: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`, `"target": "ES2022"`, `"moduleResolution": "Bundler"`.
- MUI installed: `@mui/material @emotion/react @emotion/styled`. Theme file overrides `background.default` and `background.paper` to `#FFFFFF`. Styling rules live in the `frontend-design` skill.
- Lucide installed: `lucide-react`.
- Framer Motion installed only when the user mentions animation.
- No Tailwind. Do not install it. Do not create `tailwind.config.*`.
- No global state library, no form library, no auth library on day one.

## PHP backend

- Laravel, latest stable. PHP 8.4 minimum. `declare(strict_types=1)` at the top of every PHP file you create.
- Composer with PSR-4 autoloading.
- No raw PHP starter. No Symfony unless the user asks.

## Node / Bun / TypeScript backend or library

- Bun. Same `tsconfig.json` strictness as the React block.
- Six scripts max on day one: `dev`, `build`, `start`, `typecheck`, `format`, `lint`.

## Lint and format

- Prettier with project defaults.
- ESLint configured to surface only auto-fixable rules and hard errors. Disable stylistic warnings and opinion rules. The `lint` command exits non-zero only on real problems.
- Run order: `format`, then `lint --fix`, then `typecheck`.

## Tests

Do not add a test runner during init. When the user writes the first test, install the runtime built-in: `bun test`, `node --test`, PHPUnit for Laravel. Reach for Vitest or Jest only when the project already uses them.

## Pre-commit hooks

Skip on day one. When the user wants them later, add as `.githooks/` with a `setup.sh` running `git config core.hooksPath .githooks`. Do not use Husky.

## Database

SQLite default. MySQL when there is a real reason: concurrent writes at scale, replication, existing prod stack.

## Deployment notes (only if asked)

Do not provision servers during init. When the user asks for a deployment plan, the defaults:

- OS: Ubuntu LTS. Not Debian, not Alpine, not RHEL.
- Web server: nginx. Not Apache.
- Background processes: `screen` for long-running scripts during dev. systemd for anything that must survive a reboot.

Write deployment plans as markdown notes, not as scripts, until the script is requested.

## Reject unless asked

Docker, Docker Compose, Kubernetes. CI beyond a single typecheck-and-lint job. Sentry, Datadog, OpenTelemetry. Husky, lint-staged, commitlint. Storybook. Auth libraries. Tailwind. A second CSS framework when one is already in.

## Verify

1. Run install.
2. Run `typecheck`.
3. Run `dev`, confirm it boots.
4. Print three lines of "what to do next". Not more.

Fix any failure before handing back. Do not leave a broken scaffold.
