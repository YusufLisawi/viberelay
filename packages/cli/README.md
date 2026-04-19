# viberelay CLI

Single entry point for talking to a running viberelay daemon **and** managing local Claude profiles that route through the proxy. All daemon calls hit `http://127.0.0.1:8327` by default — override with `VIBERELAY_BASE_URL`.

## Install

### One-line installer (macOS + Linux)

```bash
curl -fsSL https://github.com/vibeproxy/viberelay/releases/latest/download/install.sh | bash
```

Drops a standalone `viberelay` + `viberelay-daemon` into `~/.viberelay/bin` and symlinks them into `~/.local/bin`. Add that to your `PATH` if the installer warns you:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Overrides: `VIBERELAY_VERSION`, `VIBERELAY_PREFIX`, `VIBERELAY_BIN_DIR`, `VIBERELAY_REPO`.

### Windows (PowerShell)

```powershell
irm https://github.com/vibeproxy/viberelay/releases/latest/download/install.ps1 | iex
```

Installs to `%USERPROFILE%\.viberelay` and adds its `bin` to user PATH.

### Manual download

Grab `viberelay-<os>-<arch>.{tar.gz,zip}` from [Releases](https://github.com/vibeproxy/viberelay/releases), extract, and put `bin/viberelay` + `bin/viberelay-daemon` on your `PATH`. Keep `resources/` next to them — the daemon needs `resources/cli-proxy-api-plus` + `resources/config.yaml` + `resources/static/` at runtime.

### From source (dev)

```bash
git clone https://github.com/vibeproxy/viberelay && cd viberelay/viberelay
bun install
bunx tsx packages/cli/src/bin.ts <command>
# or run the daemon
bunx tsx packages/daemon/src/runner.ts
```

### After install — first run

The installer will prompt:

```
? Start viberelay automatically at login? [Y/n]
```

- **Y** (default): registers a launchd agent (macOS) or `systemd --user` unit (Linux). The daemon comes up on every login; you never need to run `start` manually.
- **n**: skip. Re-enable anytime with `viberelay autostart enable`.

Skip the prompt non-interactively:

```bash
VIBERELAY_AUTO_SERVICE=1 curl -fsSL .../install.sh | bash   # enable without asking
VIBERELAY_NO_SERVICE=1   curl -fsSL .../install.sh | bash   # disable without asking
```

Verify everything came up:

```bash
viberelay --version
viberelay status          # daemon health + account summary (no throw if daemon is down)
```

### Run the daemon manually

If you skipped autostart:

```bash
viberelay start           # background; idempotent; writes ~/.viberelay/state/daemon.pid
viberelay stop
viberelay restart
```

Child `cli-proxy-api-plus` runs on `127.0.0.1:8328` — managed automatically.

### First-run journey

```bash
viberelay dashboard       # sign in to Claude / Codex / etc. in the browser
viberelay accounts        # verify at least one account is active
viberelay p c             # interactive profile wizard
viberelay run -d vibe     # launches claude with that profile's env
viberelay menubar install # macOS only: live pool-usage widget in the menu bar
```

## Command map

| Command | Purpose |
| --- | --- |
| `viberelay status` | Daemon health + bind info |
| `viberelay start` | `POST /relay/start` — enable proxy |
| `viberelay stop` | `POST /relay/stop` — disable proxy (daemon stays up) |
| `viberelay accounts` | Per-provider account summary |
| `viberelay usage` | Totals + 5h / weekly quota windows |
| `viberelay dashboard` | Open web UI in browser |
| `viberelay profile list` &nbsp;(`p ls`) | List local profiles |
| `viberelay profile show <name>` &nbsp;(`p cat`) | Print a profile's JSON |
| `viberelay profile path <name>` | Print a profile's file path |
| `viberelay profile create [name]` &nbsp;(`p c`, `p new`) | Interactive wizard — new profile pointing at viberelay |
| `viberelay profile edit <name>` &nbsp;(`p e`) | Open in `$VISUAL`/`$EDITOR`, re-validates JSON on save |
| `viberelay profile set <name> [flags]` | Patch specific fields in place |
| `viberelay profile delete <name>` &nbsp;(`p rm`) | Remove a profile |
| `viberelay profile run [-d] <name> [claude args]` &nbsp;(`p r`, `p exec`) | Launch `claude` with that profile's env |
| **`viberelay run [-d] <name>`** | Top-level shortcut for `profile run` (also: `r`, `exec`) |
| `viberelay autostart [enable\|disable\|status]` | Enable/disable daemon auto-start on login (friendly alias for `service`) |
| `viberelay menubar [install\|uninstall\|status]` | macOS: install SwiftBar menu-bar plugin showing live pool usage |
| `viberelay update` | Self-upgrade to the latest release |
| `viberelay update --check` | Report if an update is available without installing |
| `viberelay update --channel nightly` | Follow the rolling `main` build |
| `viberelay --version` | Print installed version |

---

## Daemon commands

### `status`

```bash
$ viberelay status
viberelay running on 127.0.0.1:8327 (accounts 16/17)
```

### `accounts`

```bash
$ viberelay accounts
claude 1/1 active, codex 6/6 active, github-copilot 1/1 active, ollama 4/4 active
```

### `usage`

```bash
$ viberelay usage
requests 3
by provider: codex 2, claude 1
[claude]
  claude-evagrupo.developers@gmail.com — 1 req · 5h 29% left · resets 1h 25m · weekly 68% left · resets 5d
[codex]
  codex-dc1a108c-contact@brainfast.ai-team — 1 req · 5h 72% left · resets 1h 55m
  ...
```

Daemon polls `https://api.anthropic.com/api/oauth/usage` (Claude) and `https://chatgpt.com/backend-api/wham/usage` (Codex) every 5 minutes. Request counts tracked via round-robin.

### `start` / `stop`

```bash
$ viberelay start
viberelay running
$ viberelay stop
viberelay stopped
```

Soft toggles — the daemon process itself does not exit.

### `dashboard`

```bash
$ viberelay dashboard
opened http://127.0.0.1:8327/dashboard
```

Web UI: provider switches, trash icons, modal group editor, 5h countdowns, logs tab, round-robin / failover config.

---

## Profile commands

A **profile** is a local JSON file that tells `claude` to hit viberelay instead of `api.anthropic.com`, and maps `opus` / `sonnet` / `haiku` to your model-group aliases. Profiles live at `~/.viberelay/profiles/` (override via `$VIBERELAY_PROFILES_DIR`).

### Profile file shape

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

- `ANTHROPIC_BASE_URL` — where claude sends requests (the proxy).
- `ANTHROPIC_DEFAULT_*_MODEL` — the **model-group alias** each Claude tier resolves to. Viberelay's router then picks a real model with round-robin + failover.
- `ANTHROPIC_MODEL` — default top-level model (wizard sets this to the opus pick).
- `CLAUDE_CODE_SUBAGENT_MODEL` — subagent model (wizard sets this to the haiku pick).
- `account` *(optional)* — clp-style account name. When set, `run` exports `CLP_ACCOUNT` and `CLAUDE_CONFIG_DIR=~/.claude-accounts/<account>` so sessions/history/creds stay isolated.

### `create` — interactive wizard

```bash
$ viberelay profile create
? Profile name (viberelay) work-vibe
? Pick model group for opus (↑/↓ to move, enter to select)
  ▶ opus-high
    sonnet-balanced
    haiku-fast
    (skip — leave unset)
? Pick model group for sonnet  ...
? Pick model group for haiku  ...
Created profile work-vibe at /Users/you/.viberelay/profiles/work-vibe.json
  base_url=http://127.0.0.1:8327
  opus=opus-high
  sonnet=sonnet-balanced
  haiku=haiku-fast
  default_model=opus-high
  subagent_model=haiku-fast
```

**Behaviour:**

- Pulls live model groups from `GET /relay/settings-state`. If the daemon is down, prompts are skipped and you get an empty-alias profile (edit later).
- Auto-suggests picks by matching group names containing `opus` / `sonnet` / `haiku` (case-insensitive).
- TTY → arrow-key select. Non-TTY → numbered fallback.
- Pass any value as a flag to skip its prompt. Pass all values to go fully non-interactive.

**Flags:**

| Flag | Effect |
| --- | --- |
| `--opus <group>` | Set opus alias, skip prompt |
| `--sonnet <group>` | Set sonnet alias, skip prompt |
| `--haiku <group>` | Set haiku alias, skip prompt |
| `--default-model <model>` | Override `ANTHROPIC_MODEL` (default: opus pick) |
| `--subagent-model <model>` | Override `CLAUDE_CODE_SUBAGENT_MODEL` (default: haiku pick) |
| `--base-url <url>` | Override `ANTHROPIC_BASE_URL` (default: `$VIBERELAY_BASE_URL`) |
| `--token <token>` | Override `ANTHROPIC_AUTH_TOKEN` (default: `viberelay-local`) |
| `--account <name>` | Set clp-style account for session isolation |
| `--force` | Overwrite an existing profile |
| `--no-interactive` | Fail instead of prompting for missing values |

### `list` / `show` / `path`

```bash
$ viberelay profile list
- official
- work-vibe

$ viberelay profile show work-vibe
{ "env": { ... }, "account": "team-a" }

$ viberelay profile path work-vibe
/Users/you/.viberelay/profiles/work-vibe.json
```

### `edit` — open in your editor

```bash
$ EDITOR=nvim viberelay profile edit work-vibe
Edited profile work-vibe (/Users/you/.viberelay/profiles/work-vibe.json)
```

Uses `$VISUAL` → `$EDITOR` → `vi`. Re-parses JSON after save; errors if you produced invalid JSON.

### `set` — patch fields in place

```bash
$ viberelay profile set work-vibe --sonnet sonnet-balanced --account team-a
Updated profile work-vibe (sonnet=sonnet-balanced, account=team-a)
```

Accepts any subset of `--opus`, `--sonnet`, `--haiku`, `--default-model`, `--subagent-model`, `--base-url`, `--token`, `--account`. At least one required. Leaves untouched fields alone.

### `delete`

```bash
$ viberelay profile delete work-vibe
Deleted profile work-vibe
```

### `run` — launch claude with the profile

```bash
$ viberelay profile run work-vibe
$ viberelay profile run --dangerous work-vibe --continue
$ viberelay profile run -d work-vibe --print "Say OK"
```

Flags before the name:

| Flag | Effect |
| --- | --- |
| `-d`, `--dangerous`, `--dangerously-skip-permissions` | Pass `--dangerously-skip-permissions` to claude |

Everything after the name is forwarded to `claude` untouched.

**Under the hood:**

1. Load `<name>.json`.
2. Merge `env` into `process.env`.
3. If `account` set → export `CLP_ACCOUNT` + `CLAUDE_CONFIG_DIR=~/.claude-accounts/<account>`.
4. `spawn('claude', [...flags, ...yourArgs], { stdio: 'inherit' })`.

No daemon mutation — the profile file already wires claude to the proxy.

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `VIBERELAY_BASE_URL` | `http://127.0.0.1:8327` | Daemon address for all daemon commands + wizard group fetch |
| `VIBERELAY_PROFILES_DIR` | `~/.viberelay/profiles` | Where profile JSON files live |
| `VISUAL` / `EDITOR` | `vi` | Editor invoked by `profile edit` |

Point the CLI at a remote daemon:

```bash
VIBERELAY_BASE_URL=http://my-server:8327 viberelay status
```

## Ports

| Component | Port | Notes |
| --- | --- | --- |
| viberelay daemon | `8327` | HTTP API + dashboard |
| cli-proxy-api-plus child | `8328` | Spawned by daemon |
| VibeProxy (parent app) | `8317` / `8318` | Untouched — run side-by-side |

## Raw daemon endpoints

The CLI wraps JSON endpoints you can also curl directly:

- `GET  /status` — daemon state + accounts summary
- `GET  /accounts` — grouped accounts by provider
- `GET  /usage` — totals + `account_counts` + `provider_usage` windows
- `GET  /relay/settings-state` — provider toggles + model groups + custom models *(used by the profile wizard)*
- `GET  /relay/logs?since=<id>` — incremental child logs
- `GET  /relay/state` — combined snapshot used by the dashboard
- `GET  /v1/models` — OpenAI-style catalog (upstream + custom + group aliases + reasoning/thinking/effort variants)
- `POST /v1/chat/completions` | `/v1/messages` | `/v1/responses` — proxied with account round-robin + failover
- `POST /relay/model-groups` — create/update `{groupId, groupName, groupModels, enabled}`
- `POST /relay/model-groups/<id>` — delete group
- `POST /relay/custom-models` — add `{owner, id}` catalog entry
- `POST /relay/custom-models/delete` — remove
- `POST /relay/accounts/toggle` | `/relay/accounts/remove` — per-account mutations
- `POST /relay/providers/<provider>/toggle` — enable/disable a provider

## Quick recipes

**Chat completion through a group alias (round-robin + failover auto-applied):**

```bash
curl -s http://127.0.0.1:8327/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"high","messages":[{"role":"user","content":"hi"}]}'
```

**Create a model group:**

```bash
curl -s -X POST http://127.0.0.1:8327/relay/model-groups \
  -d 'groupId=fast&groupName=fast&groupModels=openai/gpt-5.4-mini,anthropic/claude-haiku-4-5&enabled=true'
```

**Spin up a profile + launch claude against it, all in one shell:**

```bash
viberelay profile create work-vibe \
  --opus opus-high --sonnet sonnet-balanced --haiku haiku-fast \
  --account team-a --no-interactive
viberelay profile run --dangerous work-vibe
```

**Add a local Ollama model to the catalog:**

```bash
curl -s -X POST http://127.0.0.1:8327/relay/custom-models \
  -d 'owner=ollama&id=llama3.2'
```

---

## Updating

Installed users upgrade in-place without touching the installer:

```bash
viberelay update              # latest stable release
viberelay update --check      # dry-run: prints "update available" or "up to date"
viberelay update --channel nightly   # rolling build from main
viberelay --version
```

How it works:

1. `GET https://api.github.com/repos/vibeproxy/viberelay/releases/{latest|tags/viberelay-nightly}`.
2. Resolves the archive for the current OS/arch (e.g. `viberelay-bun-darwin-arm64.tar.gz`).
3. Downloads + extracts to a temp dir.
4. Swaps each top-level subtree of `~/.viberelay/` (or `$VIBERELAY_PREFIX`) with the new copy. On Windows the currently running `bin/viberelay.exe` is renamed to `viberelay.exe.old-<ts>` first, then the new one slotted in (Windows will clear the `.old` next reboot).
5. Writes `VERSION` to the prefix.

Release channels:

| Channel | Tag | Cadence | Use |
| --- | --- | --- | --- |
| `stable` (default) | `viberelay-v*` | Cut manually (`git tag viberelay-vX.Y.Z && git push --tags`) | Production |
| `nightly` | `viberelay-nightly` (rolling) | Auto on every push to `main` | Early adopters, reproducible `main` build |

Switching channels: just pass `--channel <channel>`. Downgrading is the same command run against an older tag (set `VIBERELAY_VERSION` when running `install.sh`).

## Upstream `cli-proxy-api-plus` child

The daemon spawns `cli-proxy-api-plus` — a Go binary from [router-for-me/CLIProxyAPIPlus](https://github.com/router-for-me/CLIProxyAPIPlus). We fetch the right prebuilt archive for each target in CI:

```bash
bun run cliproxy:fetch -- --target bun-darwin-arm64            # latest upstream
bun run cliproxy:fetch -- --target bun-linux-x64 --version v6.9.28-0
```

The script writes the resolved tag to `resources/CLIPROXY_VERSION` so future `viberelay update` runs can detect a drift and refresh the child if we ever vendor that bump. To pin a specific upstream version in CI, set repo variable `CLIPROXY_VERSION=v6.9.28-0` under Settings → Variables.

## Building from source

Bun compiles both binaries into self-contained executables (no Node/Bun runtime required on the target machine).

```bash
bun run build                       # host target → dist/host/
bun run build -- --target bun-linux-x64
bun run build:all                   # every supported target

bun run package -- --target bun-darwin-arm64
# → dist/archives/viberelay-bun-darwin-arm64.tar.gz
```

Supported `--target` values: `bun-darwin-x64`, `bun-darwin-arm64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64`.

**Caveat — child binary:** the daemon spawns `cli-proxy-api-plus`, a Go binary shipped in `resources/`. The copy in this repo matches one OS/arch only; CI must drop the right build in before packaging for each target. The `release.yml` workflow in `.github/workflows/` has a checkpoint step where that fetch/build should happen.

## Releasing

Tag push triggers `.github/workflows/release.yml`, which:

1. Runs `typecheck` + `vitest run` on every target OS.
2. Builds binaries via `scripts/build.ts`.
3. Packages each target with `scripts/package-release.ts`.
4. Uploads all archives + `install.sh` + `install.ps1` to a GitHub release.

```bash
git tag viberelay-v0.1.0
git push --tags
```

Users then install with the one-liner above.
