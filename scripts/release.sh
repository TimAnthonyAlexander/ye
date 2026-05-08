#!/usr/bin/env bash
# Build cross-platform binaries (macOS arm64, Linux x64, Windows x64) and
# publish them as a GitHub release in one shot.
#
# Usage:
#   bun run release             # tag = "v" + package.json version
#   bun run release v0.0.2      # explicit tag
#
# Prereqs: gh installed and authenticated (gh auth login).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 1. Determine tag.
if [[ $# -ge 1 ]]; then
  TAG="$1"
else
  VERSION="$(bun -e 'console.log(require("./package.json").version)')"
  TAG="v${VERSION}"
fi

if ! [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "ye: invalid tag '$TAG' (expected vX.Y.Z)" >&2
  exit 1
fi

# 2. Prereq checks.
if ! command -v gh >/dev/null 2>&1; then
  echo "ye: gh (GitHub CLI) not found. Install: brew install gh" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "ye: gh not authenticated. Run: gh auth login" >&2
  exit 1
fi
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "ye: release $TAG already exists on GitHub" >&2
  exit 1
fi

# 3. Build all three binaries.
OUTDIR="dist/release/$TAG"
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

build() {
  local target="$1"
  local name="$2"
  echo "ye: building $name ($target)"
  bun run scripts/build.ts "$target" "$OUTDIR/$name"
}

build "bun-darwin-arm64" "ye-macos"
build "bun-linux-x64"    "ye-linux"
build "bun-windows-x64"  "ye-windows.exe"

# 4. Create the release and upload all three artifacts.
echo "ye: creating release $TAG"
gh release create "$TAG" \
  "$OUTDIR/ye-macos" \
  "$OUTDIR/ye-linux" \
  "$OUTDIR/ye-windows.exe" \
  --title "$TAG" \
  --generate-notes

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "ye: done → https://github.com/$REPO/releases/tag/$TAG"
