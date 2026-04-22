# viberelay

Multi-provider Claude API proxy. Point `claude` at it, share one pool of Claude / Codex / Copilot / Ollama accounts across your agents, and get round-robin + automatic failover for free.

- **Proxy + daemon** — local HTTP server that speaks Anthropic, OpenAI, and OpenAI-chat APIs and forwards to a pool of upstream accounts managed by [`cli-proxy-api-plus`](https://github.com/router-for-me/CLIProxyAPIPlus).
- **Model groups** — alias tiers like `opus-high`, `sonnet-balanced`, `haiku-fast` that map to one or more real models; the router round-robins and fails over between them.
- **Profile system** — per-workspace JSON profiles that wire `claude` to the proxy with your chosen group aliases for opus/sonnet/haiku, optional clp-style account isolation.
- **CLI** — one binary, zero Node runtime required on the target machine; self-updates from GitHub releases.
- **Web dashboard** — provider toggles, account switches, 5h / weekly quota countdowns, group editor, live logs.

## Installation

One command per platform. All binaries are self-contained — no Node or Python runtime required.

### macOS

```bash
curl -fsSL https://github.com/YusufLisawi/viberelay/releases/latest/download/install.sh | bash
```

Installs to `~/.viberelay` and symlinks `viberelay` / `viberelay-daemon` into `~/.local/bin`. Binaries are re-codesigned after extraction so Gatekeeper accepts them.

### Linux

```bash
curl -fsSL https://github.com/YusufLisawi/viberelay/releases/latest/download/install.sh | bash
```

Same flow as macOS. x86_64 and arm64 both supported. On headless boxes set `VIBERELAY_AUTO_SERVICE=1` before piping to skip the interactive prompt and enable the `systemd --user` unit.

### Windows (PowerShell)

```powershell
irm https://github.com/YusufLisawi/viberelay/releases/latest/download/install.ps1 | iex
```

### After install

1. Make sure `~/.local/bin` is on `$PATH` (the installer prints a reminder if it isn't). Add this to your shell rc:
   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   ```
2. The installer asks **"Start viberelay automatically at login? [Y/n]"** — say yes and it registers a launchd agent (macOS) or systemd `--user` unit (Linux). Pre-set `VIBERELAY_AUTO_SERVICE=1` to skip the prompt, or `VIBERELAY_NO_SERVICE=1` to opt out.
3. Verify:
   ```bash
   viberelay --version
   viberelay status            # prints daemon health + account summary
   ```
4. Sign in to at least one provider via the web UI:
   ```bash
   viberelay dashboard         # opens http://127.0.0.1:8327/dashboard
   ```
5. Create a profile and run Claude Code through the proxy:
   ```bash
   viberelay p c               # interactive wizard: name + opus/sonnet/haiku groups
   viberelay run -d vibe       # launch `claude` with profile env (-d = --dangerously-skip-permissions)
   ```
6. Optional desktop widget showing live pool usage:
   ```bash
   viberelay menubar install       # macOS: auto-installs SwiftBar via brew, drops plugin in, launches it
   viberelay appindicator install  # GNOME desktops: installs the top-bar indicator helper
   ```

### Environment overrides (installer)

| Variable | Effect |
|---|---|
| `VIBERELAY_PREFIX` | Install prefix (default `~/.viberelay`) |
| `VIBERELAY_BIN_DIR` | Where `viberelay` / `viberelay-daemon` are symlinked (default `~/.local/bin`) |
| `VIBERELAY_VERSION` | Pin a specific release tag (default `latest`) |
| `VIBERELAY_AUTO_SERVICE` | `1` = enable autostart silently |
| `VIBERELAY_NO_SERVICE` | `1` = skip autostart entirely |
| `GITHUB_TOKEN` | Auth for private-repo downloads / rate-limit relief |

### Uninstall

```bash
viberelay autostart disable           # remove service
viberelay stop
rm -rf ~/.viberelay ~/.local/bin/viberelay ~/.local/bin/viberelay-daemon
```

## Quick start

The installer asks once whether to enable daemon auto-start at login (launchd
on macOS, `systemd --user` on Linux). Say yes and viberelay is up from the next
boot onward — no manual `start` needed.

End-to-end, from zero to running Claude Code through the proxy:

```bash
viberelay status          # daemon + accounts summary
viberelay dashboard       # sign in to providers via the web UI (or `viberelay accounts` in CLI)
viberelay p c             # interactive profile wizard — name + opus/sonnet/haiku groups
viberelay run -d vibe     # launch `claude` with that profile's env (-d = --dangerously-skip-permissions)
```

### Aliases

Muscle-memory shortcuts so you never type `viberelay profile run --dangerous` again.

| Full | Short |
|---|---|
| `viberelay profile run --dangerous <name>` | `viberelay run -d <name>` |
| `viberelay profile list` | `viberelay p ls` |
| `viberelay profile create` | `viberelay p c` |
| `viberelay profile edit <n>` | `viberelay p e <n>` |
| `viberelay profile delete <n>` | `viberelay p rm <n>` |
| `viberelay profile show <n>` | `viberelay p cat <n>` |
| `viberelay service install` | `viberelay autostart enable` |
| `viberelay service uninstall` | `viberelay autostart disable` |

### macOS menu bar (optional)

```bash
viberelay menubar install   # auto-installs SwiftBar via brew, drops plugin in place, launches it
```

Click the menu-bar icon to see pool-wide usage, per-account 5h/weekly windows,
the next account about to rotate in (▶), and the last model group + real model
that was routed.

### GNOME top-bar indicator (optional)

```bash
viberelay appindicator install
```

This installs a small GNOME AppIndicator helper under `~/.config/viberelay/appindicator/`
and an autostart desktop entry under `~/.config/autostart/` so the indicator appears
in the GNOME top bar for the current session and future logins.

### Self-update

```bash
viberelay update --check                 # latest stable
viberelay update --channel nightly       # rolling build from main
```

Everything else: **[packages/cli/README.md](packages/cli/README.md)** — full command reference, profile flags, release pipeline, HTTP endpoints.

## Architecture

```
┌──────────────┐    ┌──────────────────────┐    ┌────────────────────────┐
│  claude /    │    │  viberelay-daemon    │    │  cli-proxy-api-plus    │
│  agents      ├──► │  :8327 (Node/Bun)    ├───►│  :8328 (Go)            │
│  (your apps) │    │  • dashboard          │    │  • upstream pools      │
│              │    │  • model-group router │    │  • round-robin         │
│              │    │  • settings store     │    │  • token refresh       │
└──────────────┘    └──────────────────────┘    └─────────┬──────────────┘
                                                          │
                         ┌────────────────────────────────┼──────────────┐
                         ▼                                ▼              ▼
                 Claude OAuth accts            Codex / ChatGPT        Ollama, etc.
```

- `viberelay-daemon` owns the public HTTP surface, the dashboard, model-group routing, settings persistence.
- `cli-proxy-api-plus` (bundled from upstream) holds provider accounts, rotates tokens, and forwards to the real upstream APIs.
- `viberelay` (CLI) is a thin client over the daemon's HTTP endpoints + a local profile manager for Claude Code.

## Repo layout

```
packages/
  cli/       # `viberelay` binary — commands, profile wizard, self-update
  daemon/    # `viberelay-daemon` binary — HTTP server + dashboard
  shared/    # types shared between cli & daemon
resources/   # config.yaml, dashboard static, upstream cli-proxy-api-plus (fetched in CI)
scripts/
  build.ts             # Bun --compile cross-target
  package-release.ts   # tar.gz / zip per target with bins + resources
  fetch-cliproxy.ts    # pulls the matching upstream Go binary
install.sh / install.ps1   # one-liner installers
.github/workflows/
  release.yml    # tag push → stable release assets on GitHub
  nightly.yml    # main push → rolling `viberelay-nightly` release
```

## Develop

Requires [Bun](https://bun.sh).

```bash
bun install
bun run typecheck
bunx vitest run

# Run daemon + CLI straight from source
bunx tsx packages/daemon/src/runner.ts
bunx tsx packages/cli/src/bin.ts status
```

Fetch the upstream Go child once (per OS/arch you target), then compile:

```bash
bun scripts/fetch-cliproxy.ts --target bun-darwin-arm64
bun run build                         # host target
bun run build -- --target bun-linux-x64
bun run package -- --target bun-darwin-arm64
```

## Release

- **Stable:** `git tag viberelay-v0.2.0 && git push --tags` — triggers `release.yml`, publishes archives + installers to a new GitHub release. Users `viberelay update` picks it up.
- **Nightly:** every push to `main` triggers `nightly.yml`, which stamps `<version>-nightly.<ts>.<sha>` and force-pushes a rolling `viberelay-nightly` tag + prerelease. Users `viberelay update --channel nightly` picks it up.

## License

MIT. See [`LICENSE`](./LICENSE).
