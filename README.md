# viberelay

Multi-provider Claude API proxy. Point `claude` at it, share one pool of Claude / Codex / Copilot / Ollama accounts across your agents, and get round-robin + automatic failover for free.

- **Proxy + daemon** — local HTTP server that speaks Anthropic, OpenAI, and OpenAI-chat APIs and forwards to a pool of upstream accounts managed by [`cli-proxy-api`](https://github.com/router-for-me/CLIProxyAPI).
- **Model groups** — alias tiers like `high`, `mid`, `low` that map to one or more real models. Pick a distribution strategy per group: **round-robin**, **weighted** (e.g. 70/20/10 split), or **primary + fallback**. Failover on errors works under all three.
- **Workspace labels** — same email across multiple ChatGPT team workspaces is auto-disambiguated (plan + workspace id suffix); set a custom display name per account from the dashboard.
- **Profile system** — per-workspace JSON profiles that wire `claude` to the proxy with your chosen group aliases for opus/sonnet/haiku, optional clp-style account isolation.
- **Multi-machine** — `viberelay sync` mirrors auth tokens / settings (and optionally `~/.claude` config + viberelay profiles) over SSH; `viberelay use remote <host>` tunnels a remote daemon to `127.0.0.1:8327` so every client (Claude Code, openclaw, SwiftBar) keeps using the same URL.
- **OpenClaw integration** — `viberelay openclaw setup` writes a provider into `~/.openclaw/openclaw.json` with your live model groups, switchable from any chat (Telegram, Discord, …) via `/model viberelay/<group>`.
- **CLI** — one binary, zero Node runtime required on the target machine; self-updates from GitHub releases.
- **Web dashboard** — provider toggles, account switches, 5h / weekly quota countdowns, group editor with strategy picker, custom labels, live logs.

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

## Model groups & distribution strategies

Each group has a list of real models the router can pick from, and a strategy that decides **how** it picks. Failover on upstream errors (429/500/etc, invalid thinking signature, model_not_supported) walks the rest of the list regardless of strategy.

| Strategy | Behavior |
|---|---|
| `round-robin` (default) | rotate through models, one per request |
| `weighted` | split traffic by per-model weights (e.g. `70, 20, 10` → 70/20/10) |
| `primary` | always try `models[0]`; only walk the rest on errors |

Edit a group from the dashboard: pick the strategy from the dropdown; for `weighted` enter comma-separated weights in the same order as the models. Live shape (% per chip, "primary" tag) is shown in the list view.

## Multi-machine workflows

Common pattern: a beefy Linux home server runs viberelay 24/7 (more accounts, no laptop sleep), laptops/tablets sync credentials to it and tunnel its dashboard.

### `viberelay sync` — mirror state to another host

```bash
viberelay sync user@100.125.21.37            # push tokens + settings (default)
viberelay sync user@host --pull              # pull instead
viberelay sync user@host --restart           # bounce remote daemon after push
viberelay sync user@host --dry-run

# bigger payloads
viberelay sync user@host --profiles          # also ~/.viberelay/profiles/
viberelay sync user@host --claude            # curated ~/.claude/ subset
viberelay sync user@host --all               # tokens + settings + profiles + claude
```

Always synced: `~/.cli-proxy-api/*.json` (OAuth tokens / API keys) + `~/.viberelay/state/settings-state.json` (account labels, model groups, prefs).

`--claude` curated subset: `CLAUDE.md`, `settings.json`, `keybindings.json`, `agents/`, `commands/`, `hooks/`, `skills/`, `plugins/`. Skipped: `projects/`, `sessions/`, `history.jsonl`, `cache/`, `paste-cache/`, `file-history/`, `shell-snapshots/`, `todos/`, `plans/`, `backups/`, `debug/`, `ide/`, `~/.claude.json` (machine-local or live state).

Mechanism: `rsync -az` over `ssh`. Tailscale IPs work as the host. `--delete` is push-only (so a half-empty laptop pull never wipes the remote).

### `viberelay use` — switch between local and tunneled remote daemon

```bash
viberelay use remote user@100.125.21.37   # stops local, opens ssh -L 8327:127.0.0.1:8327
viberelay use local                       # closes tunnel, restarts local daemon
viberelay use show                        # current mode + tunnel pid health
viberelay use refresh                     # reconcile (clears dead tunnel pid)
```

Once tunneled, every client keeps using `http://127.0.0.1:8327` — Claude Code profiles, openclaw, SwiftBar, dashboard URLs all keep working unchanged. State persists at `~/.viberelay/state/active.json`. SwiftBar reads this and shows "Server: tunneled → user@host" + a "Switch to local" menu item when remote.

### `viberelay dashboard <user@host>` — view a remote dashboard

```bash
viberelay dashboard user@host             # SSH-tunnels remote :8327 → http://127.0.0.1:18327
```

Foreground command: opens browser to the tunnel URL (Cmd-clickable in terminal), Ctrl-C tears down the tunnel. Independent from `use remote` — just for one-off inspection.

## OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) is a personal AI assistant that runs on your devices and routes through chat channels (Telegram, Discord, Slack, etc.). `viberelay openclaw` wires it through the local proxy so users can switch between your model groups via in-chat slash commands.

```bash
viberelay openclaw setup                  # auto-discovers live groups from running daemon
viberelay openclaw setup --set-default-model claude-sonnet-4-5
viberelay openclaw refresh                # re-pull catalog (after creating new groups)
viberelay openclaw status                 # confirm wiring
viberelay openclaw print                  # dump the JSON snippet without writing
```

In a chat: `/model viberelay/high`, `/model viberelay/mid`, `/model viberelay/<your-custom-group>`. OpenClaw's `/model list` picker shows everything viberelay's `/v1/models` exposes.

Existing config in `~/.openclaw/openclaw.json` is merged (other providers preserved); a timestamped `.bak` is written before each change.

Everything else: **[packages/cli/README.md](packages/cli/README.md)** — full command reference, profile flags, release pipeline, HTTP endpoints.

## Architecture

```
┌──────────────┐    ┌──────────────────────┐    ┌────────────────────────┐
│  claude /    │    │  viberelay-daemon    │    │  cli-proxy-api    │
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
- `cli-proxy-api` (bundled from upstream) holds provider accounts, rotates tokens, and forwards to the real upstream APIs.
- `viberelay` (CLI) is a thin client over the daemon's HTTP endpoints + a local profile manager for Claude Code.

## Repo layout

```
packages/
  cli/       # `viberelay` binary — commands, profile wizard, self-update
  daemon/    # `viberelay-daemon` binary — HTTP server + dashboard
  shared/    # types shared between cli & daemon
resources/   # config.yaml, dashboard static, upstream cli-proxy-api (fetched in CI)
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
