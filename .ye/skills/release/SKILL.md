---
name: release
description: Cut a Ye release — bump package.json, commit, push, and publish cross-platform binaries to GitHub via `bun run release`. Use whenever the user says "ship", "release", "release this", "publish", "cut a release", "bump version", "ship v1.x.y", or any equivalent phrasing that indicates they want a new tagged release of Ye. Trigger even when no version number is named — default to a patch bump and ask only if the request is ambiguous.
---

# Release

End-to-end flow for cutting a tagged Ye release. Execute the steps in order. Do not ask for confirmation unless a preflight check surfaces an anomaly (dirty tree with unrelated work, branch behind origin, tag already exists). The user knows what release means; just do it.

## Inputs to determine

1. **Bump type.** Patch (X.Y.Z+1) is the default — most releases are refinements. Minor (X.Y+1.0) when the user says "minor", "feature release", or describes substantial new functionality. Major (X+1.0.0) when the user says "major" or describes a breaking change. If the user did not say which and the recent commits are mixed, default to patch and mention it in your response so they can correct.
2. **Release summary line.** A short `<scope> — <thing>` blurb for the release commit message. Derive it from the commits since the previous release tag (`git log <prev-tag>..HEAD --oneline`). Keep it under 70 chars total.

## Preflight

Run these in parallel via Bash. If any fail, surface the exact problem and stop — do not push or release.

- `git status --short` — must be empty, OR all uncommitted files must be related to the release work (commit them as feature commits in the next step). Unrelated dirty work means stop and ask.
- `git branch --show-current` — must be `main`. Other branches cannot release.
- `git fetch origin main && git log HEAD..origin/main --oneline` — must be empty (local up-to-date or ahead). If origin has commits we don't have, pull first (`git pull --ff-only origin main`); refuse if a non-fast-forward.
- `gh auth status` — must show authenticated. If not, stop and tell the user to `gh auth login`.
- Read `package.json` to get the current version, compute the next version per bump type, then check `gh release view "v<next>"`. If the release already exists, stop and ask whether to bump further.

## Execute

### Step 1 — Commit any uncommitted feature work

If `git status --short` showed uncommitted changes that ARE part of this release (typical: a feature commit + a release marker commit, two-commit pattern from past releases), stage and commit them separately by logical scope before bumping the version. Use conventional commit format:

- `feat(<scope>): <description>` for new features.
- `fix(<scope>): <description>` for bug fixes.
- `refactor(<scope>): <description>` for restructuring without behavior change.
- `docs(<scope>): <description>` for documentation-only changes.
- `chore(<scope>): <description>` for tooling, deps, version bumps.

One commit per logical change; do not bundle unrelated work into one commit. Look at past commits with `git log --oneline -10` to mirror the project's tone (terse, lowercase after the colon, no period).

If the only uncommitted file is `package.json`, skip this step — it goes in the release marker commit (next step).

### Step 2 — Bump the version

Edit `package.json`'s `version` field to the new version. Use the `Edit` tool, not Bash. Do not edit anything else in `package.json`.

### Step 3 — Commit the release marker

```
git add package.json
git commit -m "chore(release): v<X.Y.Z> — <summary>"
```

The summary follows the em-dash and reflects what changed since the last release. Examples from history:
- `chore(release): v1.4.0 — skills system + marketplace install`
- `chore(release): v1.4.1 — skill manifest + install workflow polish`

### Step 4 — Push

```
git push origin main
```

### Step 5 — Run the release script

```
bun run release
```

This script (`scripts/release.sh`):
- Reads the version from `package.json`, computes the tag as `v<version>`.
- Refuses if the tag already exists on GitHub.
- Builds three binaries via `bun build --compile`: `ye-macos` (darwin-arm64), `ye-linux` (linux-x64), `ye-windows.exe` (windows-x64).
- Calls `gh release create` with all three artifacts and `--generate-notes`.

The script takes 1–2 minutes; the three builds run sequentially.

### Step 6 — Report

Tell the user:
- The new tag (e.g. v1.4.2).
- The release URL (the script prints it on success).
- A short bulleted list of what's in the release, derived from the commits since the previous tag. Three to six bullets, terse, useful for changelog scanners.

## Anti-patterns

- Do not run `git tag` manually — `gh release create` creates the tag on GitHub at HEAD when it doesn't already exist.
- Do not skip the push. The release script doesn't push for you; the tag will dangle if HEAD isn't on origin.
- Do not use `--no-verify` or `--no-gpg-sign` to bypass anything. If a hook fails, surface it and stop.
- Do not amend prior commits to "tidy" history before releasing. New commits only.
- Do not edit anything else in `package.json` (description, scripts, dependencies). Version field only.
- Do not sleep, poll, or check `gh release view` in a loop after running the release script. The script's exit code is authoritative — if it returned 0, the release exists.

## When to stop and ask

- Working tree has uncommitted files that are unrelated to the release. Surface them; let the user decide whether to commit, stash, or discard.
- Local branch is not `main`, or there's a non-fast-forward divergence from origin.
- The computed tag already exists on GitHub.
- The recent commit history is empty since the last tag (nothing to release).
- The user named a version that would be a downgrade or skip versions weirdly (e.g. current is 1.4.1 and they ask for 2.0.0 with no major changes — confirm before proceeding).

## Verification

After the script finishes, the release URL is the proof. The user can also run `gh release view v<X.Y.Z>` to confirm the artifacts uploaded.
