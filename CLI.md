# viberelay CLI Guide

This guide explains how to run every important `viberelay` command, how the CLI works with Claude Code, and how to set up Claude profiles cleanly so each workflow stays isolated and repeatable.

If you want the shortest path:

```bash
viberelay-daemon
viberelay profile create
viberelay profile run --dangerous vibe
```

That starts the daemon, creates a Claude profile that points at viberelay, and launches `claude` using that profile.

---

## What viberelay does

`viberelay` is local CLI client for `viberelay-daemon`.

Flow:

1. `viberelay-daemon` listens on `http://127.0.0.1:8327`
2. daemon manages routing, dashboard, settings, and model groups
3. daemon spawns `cli-proxy-api` on `127.0.0.1:8328`
4. Claude Code can be launched with env vars that point to `viberelay` instead of direct Anthropic API
5. profile files make that setup repeatable

Main binaries:

- `viberelay` — CLI client + profile manager
- `viberelay-daemon` — local daemon server

---

## Install

### macOS / Linux

```bash
curl -fsSL https://github.com/YusufLisawi/viberelay/releases/latest/download/install.sh | bash
```

### Windows PowerShell

```powershell
irm https://github.com/YusufLisawi/viberelay/releases/latest/download/install.ps1 | iex
```

### From source

```bash
git clone https://github.com/vibeproxy/viberelay && cd viberelay/viberelay
bun install
bunx tsx packages/cli/src/bin.ts <command>
bunx tsx packages/daemon/src/runner.ts
```

---

## First-time setup

### 1. Start daemon

Installed binary:

```bash
viberelay-daemon
```

Dev mode:

```bash
bunx tsx packages/daemon/src/runner.ts
```

Default ports:

- daemon: `8327`
- child `cli-proxy-api`: `8328`

### 2. Check daemon health

```bash
viberelay status
```

Expected shape:

```bash
viberelay running on 127.0.0.1:8327 (accounts 16/17)
```

### 3. Create profile for Claude

```bash
viberelay profile create
```

Wizard asks for:

- profile name
- model group for opus
- model group for sonnet
- model group for haiku
- optional defaults and account isolation

### 4. Launch Claude through profile

```bash
viberelay profile run vibe
```

If you want Claude Code dangerous mode:

```bash
viberelay profile run --dangerous vibe
```

If you want Claude to continue session:

```bash
viberelay profile run --dangerous vibe --continue
```

If you want one-shot prompt:

```bash
viberelay profile run -d vibe --print "Say OK"
```

---

## Command map

| Command | What it does |
| --- | --- |
| `viberelay status` | Show daemon health and bind info |
| `viberelay start` | Enable relay traffic |
| `viberelay stop` | Disable relay traffic but keep daemon running |
| `viberelay accounts` | Show account counts by provider |
| `viberelay usage` | Show request totals and quota windows |
| `viberelay usage --once` | Print usage once |
| `viberelay usage --watch` | Refresh usage continuously |
| `viberelay usage --interval <ms>` | Set usage refresh interval |
| `viberelay dashboard` | Open dashboard in browser |
| `viberelay service install` | Install background service |
| `viberelay service uninstall` | Remove background service |
| `viberelay service status` | Show service state |
| `viberelay profile list` | List saved profiles |
| `viberelay profile show <name>` | Print profile JSON |
| `viberelay profile path <name>` | Print file path for profile |
| `viberelay profile create [name]` | Create profile interactively or via flags |
| `viberelay profile edit <name>` | Edit profile JSON in editor |
| `viberelay profile set <name> ...` | Patch profile fields |
| `viberelay profile delete <name>` | Delete profile |
| `viberelay profile run <name> [claude args...]` | Launch Claude with profile env |
| `viberelay update` | Self-update to latest stable |
| `viberelay update --check` | Check for update only |
| `viberelay update --channel nightly` | Update to rolling nightly |
| `viberelay --version` | Print installed version |

---

## Core daemon commands

### `viberelay status`

Use this first when debugging.

```bash
viberelay status
```

What it tells you:

- daemon up or down
- bind address
- account availability summary

### `viberelay start`

```bash
viberelay start
```

Enables relay routing. Does **not** start process itself if daemon not running.

### `viberelay stop`

```bash
viberelay stop
```

Disables relay routing. Daemon stays alive.

### `viberelay accounts`

```bash
viberelay accounts
```

Shows provider summary like Claude, Codex, Copilot, Ollama.

### `viberelay usage`

```bash
viberelay usage
```

Example:

```bash
requests 3
by provider: codex 2, claude 1
[claude]
  claude-user@example.com — 1 req · 5h 29% left · resets 1h 25m · weekly 68% left · resets 5d
```

Useful forms:

```bash
viberelay usage --once
viberelay usage --watch
viberelay usage --interval 5000
```

### `viberelay dashboard`

```bash
viberelay dashboard
```

Opens:

```text
http://127.0.0.1:8327/dashboard
```

Good for:

- provider toggles
- account state
- model groups
- logs
- quota windows

---

## Service commands

Use when you want daemon managed in background.

### Install service

```bash
viberelay service install
```

Platform behavior:

- macOS: `launchd`
- Linux: `systemd --user`

### Check service

```bash
viberelay service status
```

### Remove service

```bash
viberelay service uninstall
```

---

## Profile system

Profile = JSON file that tells Claude Code to use `viberelay`.

Default location:

```text
~/.viberelay/profiles/
```

Override location:

```bash
export VIBERELAY_PROFILES_DIR=/some/other/path
```

### Profile shape

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8327",
    "ANTHROPIC_AUTH_TOKEN": "viberelay-local",
    "ANTHROPIC_MODEL": "opus-high",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus-high",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet-balanced",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku-fast",
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku-fast"
  },
  "account": "team-a"
}
```

### What each env var means

- `ANTHROPIC_BASE_URL` — where Claude sends requests
- `ANTHROPIC_AUTH_TOKEN` — local token expected by relay, usually `viberelay-local`
- `ANTHROPIC_MODEL` — default model Claude starts with
- `ANTHROPIC_DEFAULT_OPUS_MODEL` — profile alias for Opus tier
- `ANTHROPIC_DEFAULT_SONNET_MODEL` — profile alias for Sonnet tier
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` — profile alias for Haiku tier
- `CLAUDE_CODE_SUBAGENT_MODEL` — default subagent model
- `account` — optional isolated Claude account/config namespace

### Why model groups matter

Profile does **not** need direct real model name only. It can point to alias like:

- `opus-high`
- `sonnet-balanced`
- `haiku-fast`

Then viberelay chooses real upstream model using round-robin + failover rules.

---

## `viberelay profile create`

### Interactive mode

```bash
viberelay profile create
```

Or with explicit name:

```bash
viberelay profile create work-vibe
```

Wizard behavior:

- fetches model groups from `GET /relay/settings-state`
- tries to auto-suggest names matching `opus`, `sonnet`, `haiku`
- on TTY uses arrow-key picker
- without TTY uses numbered fallback
- if daemon down, can still create mostly empty profile and edit later

### Non-interactive mode

```bash
viberelay profile create work-vibe \
  --opus opus-high \
  --sonnet sonnet-balanced \
  --haiku haiku-fast \
  --default-model opus-high \
  --subagent-model haiku-fast \
  --account team-a \
  --no-interactive
```

### Create flags

| Flag | Meaning |
| --- | --- |
| `--opus <group>` | Set Opus alias |
| `--sonnet <group>` | Set Sonnet alias |
| `--haiku <group>` | Set Haiku alias |
| `--default-model <model>` | Set `ANTHROPIC_MODEL` |
| `--subagent-model <model>` | Set `CLAUDE_CODE_SUBAGENT_MODEL` |
| `--base-url <url>` | Override relay URL |
| `--token <token>` | Override auth token |
| `--account <name>` | Set isolated Claude account namespace |
| `--force` | Overwrite existing profile |
| `--no-interactive` | Fail if missing values instead of prompting |

---

## `viberelay profile list`

```bash
viberelay profile list
```

Example:

```bash
- official
- work-vibe
```

---

## `viberelay profile show`

```bash
viberelay profile show work-vibe
```

Prints full JSON.

Good for checking:

- base URL
- model aliases
- account isolation

---

## `viberelay profile path`

```bash
viberelay profile path work-vibe
```

Prints exact file path.

Useful when you want to inspect or diff profile manually.

---

## `viberelay profile edit`

```bash
EDITOR=nvim viberelay profile edit work-vibe
```

Editor selection order:

1. `$VISUAL`
2. `$EDITOR`
3. `vi`

CLI re-parses JSON after save. Invalid JSON fails.

---

## `viberelay profile set`

Patch one or more profile fields without opening editor.

```bash
viberelay profile set work-vibe --sonnet sonnet-balanced --account team-a
```

Supports same field flags as create:

- `--opus`
- `--sonnet`
- `--haiku`
- `--default-model`
- `--subagent-model`
- `--base-url`
- `--token`
- `--account`

At least one field required.

---

## `viberelay profile delete`

```bash
viberelay profile delete work-vibe
```

Removes profile file.

Use carefully if other scripts depend on same profile name.

---

## `viberelay profile run`

This is main command for Claude workflows.

### Basic run

```bash
viberelay profile run work-vibe
```

This does:

1. loads `work-vibe.json`
2. merges `env` into shell environment
3. if `account` exists, exports:
   - `CLP_ACCOUNT=<account>`
   - `CLAUDE_CONFIG_DIR=~/.claude-accounts/<account>`
4. spawns `claude`
5. forwards all remaining args to `claude`

### Dangerous mode

```bash
viberelay profile run --dangerous work-vibe
```

Also accepts:

```bash
viberelay profile run -d work-vibe
viberelay profile run --dangerously-skip-permissions work-vibe
```

### Pass Claude args through unchanged

```bash
viberelay profile run work-vibe --continue
viberelay profile run work-vibe --print "hello"
viberelay profile run work-vibe --model sonnet
```

Everything after profile name goes straight to `claude`.

### Best practice layouts

#### One profile per team or environment

```bash
viberelay profile create personal
viberelay profile create work
viberelay profile create eval
```

#### One profile per Claude account namespace

```bash
viberelay profile create work --account work
viberelay profile create sideproject --account sideproject
```

That keeps Claude history, session state, and credentials isolated under:

```text
~/.claude-accounts/work
~/.claude-accounts/sideproject
```

#### One profile per routing strategy

Examples:

- `high-throughput` → cheaper/faster subagents
- `quality` → stronger Opus alias
- `debug` → special model groups for troubleshooting

---

## How to use viberelay with Claude Code perfectly

### Goal

Make Claude Code always hit relay instead of direct Anthropic endpoint, while keeping clean separation between contexts.

### Recommended setup

#### Profile 1: daily driver

```bash
viberelay profile create daily \
  --opus opus-high \
  --sonnet sonnet-balanced \
  --haiku haiku-fast \
  --default-model opus-high \
  --subagent-model haiku-fast \
  --account daily \
  --no-interactive
```

Run it:

```bash
viberelay profile run --dangerous daily
```

#### Profile 2: work account isolation

```bash
viberelay profile create work \
  --opus opus-high \
  --sonnet sonnet-balanced \
  --haiku haiku-fast \
  --account work \
  --no-interactive
```

Run it:

```bash
viberelay profile run --dangerous work
```

#### Profile 3: lightweight subagent-heavy workflow

```bash
viberelay profile create fast \
  --opus sonnet-balanced \
  --sonnet sonnet-balanced \
  --haiku haiku-fast \
  --default-model sonnet-balanced \
  --subagent-model haiku-fast \
  --account fast \
  --no-interactive
```

### Why this setup works

- `ANTHROPIC_BASE_URL` points Claude to relay
- tier aliases map cleanly to your model groups
- `CLAUDE_CODE_SUBAGENT_MODEL` controls cheap/faster subagent routing
- `account` isolates Claude config, creds, and session data
- `profile run` removes manual env export mistakes

### Best workflow

1. start daemon once
2. verify with `viberelay status`
3. create profile once
4. run Claude only via `viberelay profile run <name>`
5. use separate `account` values for separate contexts
6. use `profile set` when routing strategy changes

### Avoid this

Manual ad-hoc exports every time:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8327
export ANTHROPIC_AUTH_TOKEN=viberelay-local
export ANTHROPIC_MODEL=opus-high
claude
```

Works, but easy to drift, forget, or mix across projects.

Profiles better.

---

## Environment variables

### CLI variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `VIBERELAY_BASE_URL` | `http://127.0.0.1:8327` | daemon URL for CLI commands |
| `VIBERELAY_PROFILES_DIR` | `~/.viberelay/profiles` | profile directory |
| `VISUAL` / `EDITOR` | `vi` | editor for `profile edit` |

Example:

```bash
VIBERELAY_BASE_URL=http://my-server:8327 viberelay status
```

### Update-related variables

Useful mostly for packaging, CI, or custom repo source:

- `VIBERELAY_REPO`
- `VIBERELAY_PREFIX`
- `GITHUB_TOKEN`
- `GH_TOKEN`
- `VIBERELAY_TOKEN`

### Install-time variables

Installer supports overrides like:

- `VIBERELAY_VERSION`
- `VIBERELAY_PREFIX`
- `VIBERELAY_BIN_DIR`
- `VIBERELAY_REPO`

---

## Raw daemon endpoints

CLI wraps these HTTP endpoints:

- `GET /status`
- `GET /accounts`
- `GET /usage`
- `GET /relay/settings-state`
- `GET /relay/logs?since=<id>`
- `GET /relay/state`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/messages`
- `POST /v1/responses`
- `POST /relay/model-groups`
- `POST /relay/model-groups/<id>`
- `POST /relay/custom-models`
- `POST /relay/custom-models/delete`
- `POST /relay/accounts/toggle`
- `POST /relay/accounts/remove`
- `POST /relay/providers/<provider>/toggle`

Use CLI first. Hit raw endpoints when scripting or debugging.

---

## Update commands

### Check for updates

```bash
viberelay update --check
```

### Update stable

```bash
viberelay update
```

### Update nightly

```bash
viberelay update --channel nightly
```

### Show version

```bash
viberelay --version
```

Release channels:

- `stable` — tagged releases
- `nightly` — rolling build from `main`

---

## Build and package commands

Repo scripts:

```bash
bun run test
bun run test:watch
bun run typecheck
bun run lint
bun run build
bun run build:all
bun run package
bun run cliproxy:fetch
```

### Typical dev loop

```bash
bun install
bun run typecheck
bun run test
bunx tsx packages/daemon/src/runner.ts
bunx tsx packages/cli/src/bin.ts status
```

### Build host target

```bash
bun run build
```

### Build all targets

```bash
bun run build:all
```

### Package release archive

```bash
bun run package -- --target bun-darwin-arm64
```

### Fetch upstream child binary

```bash
bun run cliproxy:fetch -- --target bun-darwin-arm64
bun run cliproxy:fetch -- --target bun-linux-x64 --version v6.9.28-0
```

Supported example targets:

- `bun-darwin-x64`
- `bun-darwin-arm64`
- `bun-linux-x64`
- `bun-linux-arm64`
- `bun-windows-x64`

---

## Practical recipes

### Open dashboard fast

```bash
viberelay dashboard
```

### Create profile and run Claude in one sequence

```bash
viberelay profile create work-vibe \
  --opus opus-high \
  --sonnet sonnet-balanced \
  --haiku haiku-fast \
  --account team-a \
  --no-interactive

viberelay profile run --dangerous work-vibe
```

### Point CLI to another daemon

```bash
VIBERELAY_BASE_URL=http://192.168.1.20:8327 viberelay status
```

### Edit profile in Neovim

```bash
EDITOR=nvim viberelay profile edit work-vibe
```

### Patch only subagent model

```bash
viberelay profile set work-vibe --subagent-model haiku-fast
```

---

## Troubleshooting

### `viberelay status` fails

Check:

- daemon running
- right `VIBERELAY_BASE_URL`
- port `8327` reachable

### `profile create` shows no model groups

Likely daemon down or no groups configured yet.

Fix:

1. start daemon
2. open dashboard
3. configure model groups
4. rerun create or patch profile with `profile set`

### `profile run` launches Claude but routing wrong

Check profile:

```bash
viberelay profile show work-vibe
```

Verify:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_MODEL`
- `ANTHROPIC_DEFAULT_*_MODEL`
- `CLAUDE_CODE_SUBAGENT_MODEL`

### Need isolated Claude state

Use different `--account` values per profile.

### Want full manual control

Use `profile edit` and inspect actual JSON.

---

## Recommended daily commands

```bash
viberelay status
viberelay dashboard
viberelay usage --watch
viberelay profile list
viberelay profile run --dangerous daily
```

---

## Recommended profile strategy

If you want clean, reliable Claude usage:

- one daemon
- multiple profiles
- one `account` per context
- one route strategy per profile
- always launch Claude through `viberelay profile run`

That gives repeatable routing, isolated Claude state, and clean switching between work modes.

---

## Multi-machine + remote workflows

### Sync credentials and settings (`sync`)

```bash
viberelay sync user@host                     # push tokens + settings (default)
viberelay sync user@host --pull              # pull instead of push
viberelay sync user@host --port 22           # non-default SSH port
viberelay sync user@host --dry-run           # preview rsync changes
viberelay sync user@host --restart           # also `viberelay restart` on remote after push

viberelay sync user@host --profiles          # also ~/.viberelay/profiles/
viberelay sync user@host --claude            # curated ~/.claude/ subset
viberelay sync user@host --all               # tokens + settings + profiles + claude
```

Mechanism: `rsync -az` over `ssh`. Tailscale IPs work as the host. `--delete` is push-only (a pull never wipes additions on the local side).

`--claude` carries: `CLAUDE.md`, `settings.json`, `keybindings.json`, `agents/`, `commands/`, `hooks/`, `skills/`, `plugins/`. It deliberately skips: `projects/`, `sessions/`, `history.jsonl`, caches, `paste-cache/`, `file-history/`, `shell-snapshots/`, `todos/`, `plans/`, `backups/`, `debug/`, `ide/`, and `~/.claude.json` (live session state).

### Tunnel a remote daemon (`use`)

```bash
viberelay use remote user@host               # stops local, opens ssh -L 8327:127.0.0.1:8327
viberelay use local                          # tears down tunnel, starts local daemon
viberelay use show                           # current mode + ssh pid health
viberelay use refresh                        # reconcile (clear dead tunnel pid)
```

Tunnel options: `--ssh-port`, `--remote-port`, `--local-port`. State persists at `~/.viberelay/state/active.json` so subsequent `viberelay status`/`usage`/`dashboard` calls go to the remote daemon transparently. The SwiftBar plugin reads the same state file and shows tunnel mode + a "Switch to local" menu item.

### One-off remote dashboard (`dashboard <host>`)

```bash
viberelay dashboard user@host                # SSH-tunnels :8327 → http://127.0.0.1:18327
viberelay dashboard user@host --ssh-port 2222 --remote-port 8327 --local-port 18327
```

Foreground command — opens browser, blocks on the SSH tunnel, Ctrl-C closes it. Independent from `use remote`.

---

## OpenClaw integration

```bash
viberelay openclaw setup                     # auto-discover groups from running daemon
viberelay openclaw setup --set-default-model claude-sonnet-4-5
viberelay openclaw refresh                   # re-pull live catalog
viberelay openclaw status                    # confirm wiring
viberelay openclaw print                     # dump JSON snippet without writing
viberelay openclaw setup --static            # skip discovery, use baked-in defaults
```

Writes a `viberelay` provider into `~/.openclaw/openclaw.json` pointing at `http://127.0.0.1:8327/v1` with a curated subset of models (every viberelay-owned group, plus clean `claude-{opus,sonnet,haiku}-N-N` and `gpt-N.N(-mini|nano|codex)?` ids). In a chat (Telegram, Discord, …): `/model viberelay/high` (or any group/model id).

---

## Model group strategies

When editing a group from the dashboard, pick a strategy:

| Strategy | Picks |
|---|---|
| `round-robin` (default) | rotate through models, one per request |
| `weighted` | split by per-model weights, e.g. `70, 20, 10` |
| `primary` | always `models[0]`; only walk the rest on errors |

Failover on errors (429/500/502/503, invalid thinking signature, model_not_supported) walks the rest of the list under all strategies. Weights are a comma-separated list in the same order as the models; missing/zero weights degrade to round-robin behavior.
