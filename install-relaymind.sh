#!/usr/bin/env bash
# One-shot installer for the relaymind standalone binary (macOS + Linux).
#
#   curl -fsSL https://github.com/YusufLisawi/viberelay/releases/latest/download/install-relaymind.sh | bash
#
# Environment overrides:
#   RELAYMIND_VERSION   pin a specific release tag (default: latest)
#   RELAYMIND_PREFIX    install prefix (default: $HOME/.relaymind/dist)
#   RELAYMIND_BIN_DIR   where to symlink the binary (default: $HOME/.local/bin)
#   RELAYMIND_REPO      GitHub repo slug (default: YusufLisawi/viberelay)
#   RELAYMIND_INSTALL_VERBOSE  set to 1 for verbose output (also: -v flag)
#   RELAYMIND_LOCAL_ARCHIVE    skip the GitHub download and use this local
#                              .tar.gz path instead (for offline / dev-loop)
#
# Flags:
#   -v    verbose mode

set -euo pipefail

REPO="${RELAYMIND_REPO:-YusufLisawi/viberelay}"
VERSION="${RELAYMIND_VERSION:-latest}"
PREFIX="${RELAYMIND_PREFIX:-$HOME/.relaymind/dist}"
BIN_DIR="${RELAYMIND_BIN_DIR:-$HOME/.local/bin}"
VERBOSE="${RELAYMIND_INSTALL_VERBOSE:-0}"

# Parse flags
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    *) ;;
  esac
done

info()    { printf '\033[1;36m→\033[0m %s\n' "$*"; }
verbose() { [ "$VERBOSE" = "1" ] && printf '\033[0;90m  %s\033[0m\n' "$*" || true; }
fail()    { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── OS / arch detection ────────────────────────────────────────────────────────

detect_target() {
  local uname_os uname_arch os arch
  uname_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  uname_arch="$(uname -m)"

  case "$uname_os" in
    darwin) os="darwin" ;;
    linux)  os="linux"  ;;
    msys*|mingw*|cygwin*|windows*)
      fail "Windows is not supported. relaymind runs on macOS and Linux only." ;;
    *)
      fail "Unsupported OS: $uname_os" ;;
  esac

  case "$uname_arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64"   ;;
    *)
      fail "Unsupported architecture: $uname_arch (supported: x64, arm64)" ;;
  esac

  echo "bun-${os}-${arch}"
}

# ── Download URL builder ───────────────────────────────────────────────────────

resolve_version() {
  # Resolves "latest" to a concrete tag via GitHub redirect, then returns it.
  # Used only for the success message so we print the real version number.
  if [ "$VERSION" = "latest" ]; then
    # GitHub redirects /releases/latest to /releases/tag/<tag>
    local resolved
    resolved="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
      "https://github.com/${REPO}/releases/latest" 2>/dev/null || true)"
    if [ -n "$resolved" ]; then
      basename "$resolved"
    else
      echo "latest"
    fi
  else
    echo "$VERSION"
  fi
}

resolve_url() {
  local target="$1"
  local asset="relaymind-${target}.tar.gz"
  if [ "$VERSION" = "latest" ]; then
    echo "https://github.com/${REPO}/releases/latest/download/${asset}"
  else
    echo "https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
  fi
}

# ── Cleanup trap ──────────────────────────────────────────────────────────────

tmp=""
cleanup() {
  if [ -n "$tmp" ] && [ -d "$tmp" ]; then
    rm -rf "$tmp" || true
  fi
}
trap cleanup EXIT

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  local target url

  # Windows check (belt-and-suspenders: uname may not exist in pure-Windows env)
  if [ "${OS:-}" = "Windows_NT" ]; then
    fail "Windows is not supported. relaymind runs on macOS and Linux only."
  fi

  target="$(detect_target)"
  url="$(resolve_url "$target")"

  verbose "repo:    $REPO"
  verbose "target:  $target"
  verbose "version: $VERSION"
  verbose "prefix:  $PREFIX"
  verbose "bin_dir: $BIN_DIR"
  verbose "url:     $url"

  tmp="$(mktemp -d)"
  local archive="$tmp/relaymind.tar.gz"
  local extract_dir="$tmp/extract"

  if [ -n "${RELAYMIND_LOCAL_ARCHIVE:-}" ]; then
    # Local-file mode for offline / dev-loop testing. Skip the GitHub download.
    if [ ! -f "$RELAYMIND_LOCAL_ARCHIVE" ]; then
      fail "RELAYMIND_LOCAL_ARCHIVE points to a missing file: $RELAYMIND_LOCAL_ARCHIVE"
    fi
    info "using local archive: $RELAYMIND_LOCAL_ARCHIVE"
    cp "$RELAYMIND_LOCAL_ARCHIVE" "$archive"
  else
    info "downloading relaymind ($target)..."
    if ! curl -fL --progress-bar "$url" -o "$archive"; then
      fail "Download failed. Check your internet connection or verify the release exists at:
  https://github.com/${REPO}/releases"
    fi
  fi

  verbose "extracting archive..."
  mkdir -p "$extract_dir"
  tar -xzf "$archive" -C "$extract_dir"

  # The tarball contains a single top-level dir: relaymind-<target>/
  #
  # Layout (as of 0.1.23):
  #   relaymind-<target>/
  #     relaymind                 ← binary
  #     LICENSE
  #     README.md
  #     plugins/
  #       relaymind/              ← copy of relaymind-plugin-cc/
  #       vibemind-telegram/      ← copy of telegram-plugin-cc/
  #
  # We install both the binary AND the plugins/ tree into
  # ${PREFIX}/${version_dir}/ so the resolver in profile-installer.ts
  # can locate the bundles by walking from `process.execPath` after
  # symlink resolution. The user-facing symlink in $BIN_DIR keeps
  # pointing only at the binary.
  local payload_dir="$extract_dir/relaymind-${target}"
  if [ ! -f "$payload_dir/relaymind" ]; then
    fail "Unexpected archive layout — relaymind binary not found at expected path."
  fi

  # Resolve concrete version for the install path
  local concrete_version
  concrete_version="$(resolve_version)"
  # Strip leading 'viberelay-v' prefix if present (tag format: viberelay-v0.1.22)
  local version_dir="${concrete_version#viberelay-}"
  version_dir="${version_dir#v}"

  local install_dir="${PREFIX}/${version_dir}"

  verbose "installing to $install_dir ..."
  mkdir -p "$install_dir"

  # Atomic install: write to a .tmp then rename
  local tmp_bin="$install_dir/relaymind.tmp"
  cp "$payload_dir/relaymind" "$tmp_bin"
  chmod +x "$tmp_bin"

  # macOS: re-sign after copy to avoid SIGKILL from Gatekeeper on ad-hoc sigs
  if [ "${target#bun-darwin}" != "$target" ] && command -v codesign >/dev/null 2>&1; then
    verbose "re-signing binary for macOS..."
    codesign --remove-signature "$tmp_bin" 2>/dev/null || true
    codesign --force --sign - "$tmp_bin" 2>/dev/null \
      || info "warning: codesign failed — binary may not run on hardened macOS"
  fi

  mv "$tmp_bin" "$install_dir/relaymind"

  # Copy the plugins/ tree next to the binary. The resolver in
  # profile-installer.ts looks for `<execPathDir>/plugins/<short-name>/`
  # before falling back to the dev source-tree walk. This is the only
  # reliable production path — the bun-compiled binary cannot walk back
  # to source via import.meta.url because that URL points into bun's
  # virtual FS.
  if [ -d "$payload_dir/plugins" ]; then
    verbose "installing plugins tree to $install_dir/plugins ..."
    rm -rf "$install_dir/plugins"
    cp -R "$payload_dir/plugins" "$install_dir/plugins"
  else
    info "warning: archive missing plugins/ — relaymind init may fall back to inline templates"
  fi

  # Symlink into BIN_DIR (idempotent)
  mkdir -p "$BIN_DIR"
  ln -sfn "$install_dir/relaymind" "$BIN_DIR/relaymind"

  verbose "symlinked: $BIN_DIR/relaymind -> $install_dir/relaymind"

  # PATH hint if BIN_DIR is not on PATH
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *)
      printf '\n\033[1;33m!\033[0m Add this to your shell rc:\n    export PATH="%s:$PATH"\n' "$BIN_DIR"
      ;;
  esac

  printf '\n\033[1;32m✓\033[0m relaymind %s installed at %s/relaymind.\n' \
    "$concrete_version" "$BIN_DIR"
  printf '  Run \033[1mrelaymind init\033[0m to set up your profile.\n\n'
}

main "$@"
