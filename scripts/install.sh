#!/usr/bin/env bash
# Build Ye into a single binary and link it onto $PATH.
# Supports macOS (arm64/x64) and Linux (x64/arm64).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 1. Detect target.
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64|aarch64) TARGET="bun-darwin-arm64" ;;
      x86_64)        TARGET="bun-darwin-x64" ;;
      *)
        echo "ye: unsupported macOS arch $ARCH" >&2
        exit 1
        ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64)   TARGET="bun-linux-x64" ;;
      aarch64)  TARGET="bun-linux-arm64" ;;
      *)
        echo "ye: unsupported Linux arch $ARCH" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "ye: unsupported OS $OS" >&2
    exit 1
    ;;
esac

# 2. Dependency check: ripgrep is required by the Grep tool.
if ! command -v rg >/dev/null 2>&1; then
  echo "ye: warning — ripgrep (rg) not on PATH. The Grep tool will fail until you install it (e.g., 'apt install ripgrep' or 'brew install ripgrep')."
fi

# 3. Build.
# Delegated to scripts/build.ts so we can attach a Bun plugin that stubs
# `react-devtools-core` (Ink imports it from inside a gated branch, but
# `bun build --compile` bundles the gated module's static imports regardless,
# so the unresolvable react-devtools-core import crashes the binary at startup
# without the stub). Don't replace this with `bun build --external ...` — the
# external rewrite leaves an unresolved require in the binary and ye won't
# start.
mkdir -p dist
echo "ye: building → dist/ye ($TARGET)"
bun run scripts/build.ts "$TARGET" dist/ye

# 4. Pick a writable PATH directory and link.
pick_link_dir() {
  local candidates=("$HOME/.local/bin" "$HOME/bin" "/usr/local/bin")
  for d in "${candidates[@]}"; do
    if [[ ":$PATH:" == *":$d:"* ]] && [[ -d "$d" || ! -e "$d" ]]; then
      mkdir -p "$d"
      if [[ -w "$d" ]]; then
        echo "$d"
        return 0
      fi
    fi
  done
  return 1
}

if LINK_DIR="$(pick_link_dir)"; then
  LINK_PATH="$LINK_DIR/ye"
  ln -sf "$REPO_ROOT/dist/ye" "$LINK_PATH"
  echo "ye: linked $LINK_PATH → $REPO_ROOT/dist/ye"
  echo "ye: try 'ye' (make sure $LINK_DIR is on \$PATH)"
else
  echo "ye: no writable PATH directory found in \$HOME/.local/bin, \$HOME/bin, /usr/local/bin." >&2
  echo "ye: build is at $REPO_ROOT/dist/ye — symlink it manually." >&2
  exit 1
fi
