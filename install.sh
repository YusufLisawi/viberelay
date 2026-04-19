#!/usr/bin/env bash
# One-shot installer for viberelay (macOS + Linux).
#
#   curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | bash
#
# Environment overrides:
#   VIBERELAY_VERSION   pin a specific release tag (default: latest)
#   VIBERELAY_PREFIX    install prefix (default: $HOME/.viberelay)
#   VIBERELAY_BIN_DIR   where to symlink binaries (default: $HOME/.local/bin)
#   VIBERELAY_REPO      GitHub repo slug (default: vibeproxy/viberelay)

set -euo pipefail

REPO="${VIBERELAY_REPO:-vibeproxy/viberelay}"
VERSION="${VIBERELAY_VERSION:-latest}"
PREFIX="${VIBERELAY_PREFIX:-$HOME/.viberelay}"
BIN_DIR="${VIBERELAY_BIN_DIR:-$HOME/.local/bin}"

info() { printf '\033[1;36m→\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

detect_target() {
  local uname_os uname_arch
  uname_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  uname_arch="$(uname -m)"
  case "$uname_os" in
    darwin) os="darwin" ;;
    linux)  os="linux"  ;;
    *) fail "unsupported OS: $uname_os (use install.ps1 for Windows)" ;;
  esac
  case "$uname_arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64"   ;;
    *) fail "unsupported arch: $uname_arch" ;;
  esac
  echo "bun-${os}-${arch}"
}

resolve_url() {
  local target="$1"
  local asset="viberelay-${target}.tar.gz"
  if [ "$VERSION" = "latest" ]; then
    echo "https://github.com/${REPO}/releases/latest/download/${asset}"
  else
    echo "https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
  fi
}

tmp=""
cleanup() {
  if [ -n "$tmp" ] && [[ "$tmp" =~ ^(/tmp/|/var/folders/|$TMPDIR) ]] || [[ "$tmp" == */tmp.* ]]; then
    rm -r "$tmp" || true
  fi
}
trap cleanup EXIT

main() {
  local target url
  target="$(detect_target)"
  url="$(resolve_url "$target")"
  tmp="$(mktemp -d)"

  info "downloading $url"
  local curl_auth=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl_auth=(-H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/octet-stream")
    # Private-repo downloads go through the API asset URL, not the browser redirect.
    if [ "$VERSION" = "latest" ]; then
      api_release_url="https://api.github.com/repos/${REPO}/releases/latest"
    else
      api_release_url="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
    fi
    asset_id="$(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "$api_release_url" \
      | python3 -c "import sys,json;[print(a['id']) for a in json.load(sys.stdin)['assets'] if a['name']=='viberelay-${target}.tar.gz']" || true)"
    if [ -n "$asset_id" ]; then
      url="https://api.github.com/repos/${REPO}/releases/assets/${asset_id}"
    fi
  fi
  curl -fL "${curl_auth[@]}" --progress-bar "$url" -o "$tmp/viberelay.tar.gz" \
    || fail "download failed"

  info "extracting to $PREFIX"
  mkdir -p "$PREFIX"
  tar -xzf "$tmp/viberelay.tar.gz" -C "$tmp"
  rsync -a --delete "$tmp/viberelay-${target}/" "$PREFIX/"

  chmod +x "$PREFIX/bin/viberelay" "$PREFIX/bin/viberelay-daemon"
  chmod +x "$PREFIX/resources/cli-proxy-api-plus" 2>/dev/null || true

  # macOS: Bun-compiled binaries carry an ad-hoc signature that tar invalidates.
  # Kernel sends SIGKILL on launch unless we re-sign after extraction.
  if [[ "$target" == *darwin* ]] && command -v codesign >/dev/null 2>&1; then
    for exe in "$PREFIX/bin/viberelay" "$PREFIX/bin/viberelay-daemon"; do
      codesign --remove-signature "$exe" 2>/dev/null || true
      codesign --force --sign - "$exe" >/dev/null 2>&1 || info "warning: codesign $exe failed"
    done
  fi

  mkdir -p "$BIN_DIR"
  ln -sfn "$PREFIX/bin/viberelay" "$BIN_DIR/viberelay"
  ln -sfn "$PREFIX/bin/viberelay-daemon" "$BIN_DIR/viberelay-daemon"

  info "installed to $PREFIX"
  info "symlinked binaries into $BIN_DIR"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) printf '\n\033[1;33m!\033[0m Add this to your shell rc:\n    export PATH="%s:$PATH"\n' "$BIN_DIR" ;;
  esac

  # Auto-register the OS service so the daemon comes up on every login.
  # Prompt the user when a TTY is available; default to yes when piped without
  # a controlling terminal (e.g. curl | bash from a script).
  want_service=1
  if [ "${VIBERELAY_NO_SERVICE:-0}" = "1" ]; then
    want_service=0
  elif [ "${VIBERELAY_AUTO_SERVICE:-}" = "1" ]; then
    want_service=1
  elif [ -r /dev/tty ]; then
    printf '\n\033[1;36m?\033[0m Start viberelay automatically at login? [Y/n] '
    IFS= read -r ans < /dev/tty || ans=''
    case "$ans" in [Nn]*) want_service=0 ;; esac
  fi

  if [ "$want_service" = "1" ]; then
    if "$PREFIX/bin/viberelay" service install >/dev/null 2>&1; then
      info "registered viberelay-daemon with the OS service manager"
      info "disable later with:  viberelay autostart disable"
    else
      info "warning: service registration failed; start manually with: viberelay start"
    fi
  else
    info "skipping autostart; enable later with:  viberelay autostart enable"
  fi

  info "done — try: viberelay status"
}

main "$@"
