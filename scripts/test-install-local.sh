#!/usr/bin/env bash
# Local end-to-end test of the relaymind release pipeline.
#
# What this does:
#   1. Builds `viberelay` for the host target.
#   2. Packages it as a relaymind tarball (renames the binary; smaller archive).
#   3. Runs install-relaymind.sh against the LOCAL tarball (no GitHub fetch),
#      installing into a tmp prefix so your real $HOME/.local/bin is untouched.
#   4. Smoke-tests the installed binary: `--version`, `--help`, `mem search`.
#   5. Cleans up.
#
# Use this before tagging a release.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Detect host target the same way the installer would.
detect_host_target() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    darwin) os="darwin" ;;
    linux)  os="linux"  ;;
    *) printf 'unsupported OS: %s\n' "$os" >&2; exit 1 ;;
  esac
  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64"   ;;
    *) printf 'unsupported arch: %s\n' "$arch" >&2; exit 1 ;;
  esac
  printf 'bun-%s-%s' "$os" "$arch"
}

TARGET="$(detect_host_target)"
TMP="$(mktemp -d)"
TEST_PREFIX="$TMP/prefix"
TEST_BIN_DIR="$TMP/bin"
ARCHIVE="$REPO_ROOT/dist/archives/relaymind-${TARGET}.tar.gz"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

info() { printf '\033[1;36m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Build
info "[1/5] building viberelay for $TARGET"
bun run scripts/build.ts --target "$TARGET" >/dev/null

# 2. Package
info "[2/5] packaging relaymind tarball"
bun run scripts/package-relaymind.ts --target "$TARGET" >/dev/null
[ -f "$ARCHIVE" ] || fail "tarball not produced at $ARCHIVE"
ok "tarball: $(du -h "$ARCHIVE" | cut -f1) at $ARCHIVE"

# 3. Install (offline, into the tmp prefix)
info "[3/5] running installer with RELAYMIND_LOCAL_ARCHIVE"
RELAYMIND_LOCAL_ARCHIVE="$ARCHIVE" \
RELAYMIND_PREFIX="$TEST_PREFIX" \
RELAYMIND_BIN_DIR="$TEST_BIN_DIR" \
RELAYMIND_VERSION="local-test" \
  bash "$REPO_ROOT/install-relaymind.sh"

# 4. Smoke-test the installed binary via the symlink (this is the path users hit)
INSTALLED="$TEST_BIN_DIR/relaymind"
[ -x "$INSTALLED" ] || fail "expected executable at $INSTALLED"

info "[4/5] smoke-testing installed binary at $INSTALLED"

VERSION_OUT="$("$INSTALLED" --version)"
[[ "$VERSION_OUT" == relaymind* ]] || fail "expected '--version' to start with 'relaymind', got: $VERSION_OUT"
ok "  --version → $VERSION_OUT"

HELP_OUT="$("$INSTALLED" --help | head -1)"
[[ "$HELP_OUT" == "RelayMind"* ]] || fail "expected '--help' to start with 'RelayMind', got: $HELP_OUT"
ok "  --help    → $HELP_OUT"

# Run mem against an empty tmp DB inside our test prefix so we don't pollute
# the user's real ~/.relaymind/.
TEST_CWD="$TMP/cwd"
mkdir -p "$TEST_CWD"
MEM_OUT="$(cd "$TEST_CWD" && "$INSTALLED" mem search 'nothing-should-match')"
[[ "$MEM_OUT" == *"no matches"* ]] || fail "expected 'mem search' to return no matches in clean DB, got: $MEM_OUT"
ok "  mem       → $MEM_OUT"

# Verify basename routing: invoking the same binary file directly as `viberelay`
# (by copying it under that name) goes to the viberelay command set, not relaymind.
cp "$INSTALLED" "$TMP/viberelay"
chmod +x "$TMP/viberelay"
VR_OUT="$("$TMP/viberelay" --version)"
[[ "$VR_OUT" == viberelay* ]] || fail "expected viberelay basename to route to viberelay, got: $VR_OUT"
ok "  basename  → $VR_OUT (same binary, different name)"

# 4b. Verify the plugins/ tree landed alongside the binary. The compiled
#     bun binary cannot find source via import.meta.url — this is the
#     only reliable production resolution path.
INSTALL_REAL="$(readlink "$INSTALLED" 2>/dev/null || echo "$INSTALLED")"
INSTALL_DIR_REAL="$(dirname "$INSTALL_REAL")"
[ -d "$INSTALL_DIR_REAL/plugins/relaymind" ] \
  || fail "plugins/relaymind missing next to binary at $INSTALL_DIR_REAL"
[ -d "$INSTALL_DIR_REAL/plugins/vibemind-telegram" ] \
  || fail "plugins/vibemind-telegram missing next to binary at $INSTALL_DIR_REAL"
ok "  plugins   → both bundles next to binary"

# 4c. Production-like check: from a fresh CWD with all RELAYMIND_*_ROOT
#     env vars unset, run `relaymind init` then `relaymind doctor` and
#     assert doctor passes. This is what the user actually does after
#     `curl | bash` — and the check that would have caught the resolver
#     failing inside a bun standalone binary.
FRESH_CWD="$TMP/fresh-cwd"
mkdir -p "$FRESH_CWD"
info "[4c] running init+doctor in $FRESH_CWD with no env overrides"
(
  cd "$FRESH_CWD"
  unset RELAYMIND_PLUGIN_ROOT VIBERELAY_TELEGRAM_PLUGIN_ROOT
  unset VIBERELAY_RELAYMIND_PROFILE
  "$INSTALLED" init >/dev/null
  DOCTOR_OUT="$("$INSTALLED" doctor)"
  if ! grep -q "PASS" <<<"$DOCTOR_OUT"; then
    printf '%s\n' "$DOCTOR_OUT" >&2
    exit 1
  fi
) || fail "doctor did not PASS from a fresh CWD with no env vars"
ok "  doctor    → PASS (from $FRESH_CWD with no env overrides)"

# 5. Done
info "[5/5] all smoke checks passed — install pipeline is healthy"
ok "ready to release"
