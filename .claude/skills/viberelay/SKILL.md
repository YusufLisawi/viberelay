---
name: viberelay
description: Use viberelay to route Claude Code, Codex, and other AI clients through a pooled multi-account proxy. Covers daemon lifecycle, account management, model groups (round-robin / weighted / primary), profile-based Claude launches, multi-machine sync over SSH, remote-daemon tunneling, and OpenClaw chat integration. Trigger when the user mentions viberelay, asks to switch model groups, set up a profile, sync between machines, tunnel a remote daemon, view a remote dashboard, or wire OpenClaw.
---

# viberelay

`viberelay` is a local HTTP proxy + daemon that pools multiple AI provider accounts (Claude OAuth, Codex / ChatGPT, GitHub Copilot, Ollama, OpenRouter, …) and exposes them as one Anthropic / OpenAI / OpenAI-chat compatible endpoint at `http://127.0.0.1:8327`.

## Mental model

```
client (Claude Code, openclaw, your script)
   │
   ▼
http://127.0.0.1:8327         ← viberelay-daemon (Node/Bun)
   │  routes by model alias, applies group strategy, retries on errors
   ▼
http://127.0.0.1:8328         ← cli-proxy-api (Go child, bundled)
   │  rotates account tokens, handles upstream auth refresh
   ▼
upstream APIs (Anthropic, OpenAI, …)
```

- `viberelay-daemon` owns the dashboard, model-group routing, settings store.
- `cli-proxy-api` owns the per-account OAuth tokens and upstream auth refresh.
- `viberelay` (CLI) is a thin client: lifecycle + profile manager + utilities.

## When to reach for viberelay

- User wants to share a pool of Claude / Codex / Copilot accounts across multiple Claude Code sessions or other tools without manually juggling API keys.
- User asks for round-robin or weighted model routing, or "primary then fallback".
- User runs `viberelay <anything>` and you need to assist (start, status, profile, sync, use, openclaw, dashboard).
- User wants to switch a Claude Code workspace between Sonnet / Opus / Haiku tiers without touching env vars.
- User wants Claude Code (or any compatible client) to talk to a daemon running on another machine over Tailscale.

## Daemon lifecycle

```bash
viberelay start            # idempotent — no-op if already running
viberelay stop
viberelay restart
viberelay status           # daemon + accounts summary, safe when daemon is down
viberelay logs 200         # tail last 200 lines of the daemon log

viberelay autostart enable    # register launchd (macOS) / systemd --user (Linux)
viberelay autostart disable
viberelay autostart status
```

State files (read-only for diagnostics, never edit by hand):

- `~/.viberelay/state/settings-state.json` — providers/accounts toggles, model groups, custom labels.
- `~/.viberelay/state/active.json` — `local` vs `remote (tunneled)` mode, ssh pid.
- `~/.viberelay/state/daemon.pid` — running daemon pid.
- `~/.viberelay/state/daemon.log` — append-only log.
- `~/.cli-proxy-api/*.json` — per-account OAuth tokens. Sensitive — sync over SSH only.

## Accounts

Each account is one JSON file in `~/.cli-proxy-api/`. Account types include `claude` (OAuth), `codex` (OAuth), `github-copilot`, `ollama`, `openrouter`, `nvidia`, `qwen`, etc.

- Add via dashboard: `viberelay dashboard` → "+ Add Account" per provider.
- Or via OAuth from the upstream binary directly (e.g. `cli-proxy-api -claude-login`).
- List: `viberelay accounts` or in the dashboard under each provider.
- Toggle / delete: dashboard switches; or `POST /relay/accounts/toggle` / `/relay/accounts/remove` with `{accountFile}`.

### Workspace labels (codex teams)

When the same email belongs to multiple ChatGPT team workspaces, viberelay auto-disambiguates the display name as `email · plan · #<account_id-prefix>`. To override, open the dashboard's Account Settings modal and type a custom label per account (e.g. `Acme Team`). Cleared label reverts to the auto-derived one.

## Model groups

A group is a named alias (e.g. `high`, `mid`, `low`, or any custom name) bound to a list of real model ids. Clients send the group name; the router resolves it to a real model and forwards.

Strategies (set per group, edited from the dashboard's Groups tab):

| Strategy | What it does |
|---|---|
| `round-robin` (default) | rotate through models, one per request |
| `weighted` | split by `weights: number[]` aligned to `models` (e.g. `[70, 20, 10]`) |
| `primary` | always send to `models[0]`; only walk the rest on errors |

**Failover** is independent of strategy: on `429/500/502/503`, `invalid thinking signature`, or `model_not_supported`, the router retries the next untried model in the group.

Defaults seeded on first run: `high → openai/gpt-5.4-reasoning-high`, `mid → openai/gpt-5.4-reasoning-low`, `low → openai/gpt-5.4-mini-reasoning-low`. Edit or replace freely.

Use a group as a model id in any client by passing the group name (e.g. set `ANTHROPIC_MODEL=high` for Claude Code, or POST to `/v1/messages` with `model: "high"`).

## Profiles (Claude Code workspaces)

A profile is a JSON file in `~/.viberelay/profiles/<name>.json` that bundles env vars (base URL, auth token, default models, opus/sonnet/haiku group aliases) so launching `claude` is one command.

```bash
viberelay profile create        # interactive wizard
viberelay profile list
viberelay profile show <name>
viberelay profile edit <name>
viberelay profile delete <name>

viberelay profile run <name>          # launches `claude` with the profile's env
viberelay profile run --dangerous <name>   # adds --dangerously-skip-permissions
viberelay run -d <name>               # shorthand for `profile run --dangerous`
viberelay r <name>                    # shortest alias
```

Profiles point at `http://127.0.0.1:8327` (or whatever `--base-url` was at create time). They survive sync.

## Multi-machine

### `viberelay sync` — mirror state to another host

Use over SSH. Tailscale IP works as the host. Always carries `~/.cli-proxy-api/*.json` (auth tokens) + `~/.viberelay/state/settings-state.json` (account labels, model groups, prefs). Optional payloads via flags.

```bash
viberelay sync user@host               # push (default)
viberelay sync user@host --pull
viberelay sync user@host --restart     # bounce remote daemon after push
viberelay sync user@host --dry-run

viberelay sync user@host --profiles    # also ~/.viberelay/profiles/
viberelay sync user@host --claude      # curated ~/.claude/ subset
viberelay sync user@host --all         # tokens + settings + profiles + claude
```

`--claude` includes: `CLAUDE.md`, `settings.json`, `keybindings.json`, `agents/`, `commands/`, `hooks/`, `skills/`, `plugins/`. **Excludes** (machine-local or live): `projects/`, `sessions/`, `history.jsonl`, `cache/`, `paste-cache/`, `file-history/`, `shell-snapshots/`, `todos/`, `plans/`, `backups/`, `debug/`, `ide/`, `~/.claude.json`.

`--delete` is push-only (a pull never wipes a populated laptop).

### `viberelay use` — switch this machine between local and remote daemon

```bash
viberelay use remote user@host       # stops local, opens ssh -L 8327:127.0.0.1:8327
viberelay use local                  # tears tunnel down, starts local
viberelay use show                   # current mode + ssh pid health
viberelay use refresh                # reconcile (clear dead pid)
```

Once tunneled, **every viberelay client keeps using `http://127.0.0.1:8327` unchanged** — Claude Code profiles, openclaw config, the SwiftBar plugin, dashboard URLs. Only the listener at port 8327 swaps. The SwiftBar plugin reads `~/.viberelay/state/active.json` and shows the tunnel target + a "Switch to local" menu item.

### `viberelay dashboard <user@host>` — view a remote dashboard

```bash
viberelay dashboard user@host        # SSH tunnel → http://127.0.0.1:18327/dashboard
```

Foreground; Ctrl-C closes the tunnel. Independent from `use remote` — for one-off inspection.

## OpenClaw integration

[OpenClaw](https://github.com/openclaw/openclaw) is a personal AI assistant that runs through chat channels (Telegram, Discord, Slack, …). Wire it through viberelay so users can switch model groups via in-chat slash commands.

```bash
viberelay openclaw setup             # discover live groups from running daemon
viberelay openclaw setup --set-default-model claude-sonnet-4-5
viberelay openclaw refresh           # re-pull catalog after creating new groups
viberelay openclaw status            # confirm wiring
viberelay openclaw print             # dump JSON snippet without writing
viberelay openclaw setup --static    # offline / no-daemon fallback
```

Merges a `viberelay` provider into `~/.openclaw/openclaw.json` (other providers preserved, `.bak` written first). In any OpenClaw chat: `/model viberelay/high`, `/model viberelay/mid`, `/model viberelay/<custom-group>`.

## HTTP surface (cheat sheet)

Daemon listens on `127.0.0.1:8327`. Requests are mostly OpenAI/Anthropic-compat — clients should rarely need these directly.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | liveness — `{host, port, pid, childPid}` |
| GET | `/v1/models` | full catalog (groups + upstream + synthetic variants) |
| POST | `/v1/messages`, `/v1/chat/completions`, `/v1/responses` | proxy in |
| GET | `/dashboard` | HTML dashboard |
| GET | `/usage` | JSON usage payload (used by SwiftBar / `viberelay usage`) |
| GET | `/relay/state` | full state snapshot |
| POST | `/relay/start`, `/relay/stop` | daemon controls |
| POST | `/relay/accounts/{toggle,remove,label,add}` | account mutations |
| POST | `/relay/model-groups` | upsert group `{groupId,groupName,groupModels,strategy,weights,enabled}` |
| POST/DELETE | `/relay/model-groups/<id>` | delete group |
| POST | `/relay/custom-models`, `/relay/custom-models/delete` | custom model registry |

## Common patterns / recipes

### "Make Claude Code use viberelay's `high` group for Opus"

```bash
viberelay profile create               # wizard: pick `high` for opus, etc.
viberelay run -d <profile>             # launches `claude` with env wired
```

Or set env directly:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8327
export ANTHROPIC_AUTH_TOKEN=viberelay-local
export ANTHROPIC_MODEL=high
claude
```

### "I just added a new model group — surface it everywhere"

1. Create the group in the dashboard (or POST to `/relay/model-groups`).
2. `viberelay openclaw refresh` — picks it up for chat-based picker.
3. `viberelay sync user@host` to push the new group config to other machines.

### "Run viberelay on the home server, use it from this laptop"

```bash
# on the laptop, one-time mirror of credentials
viberelay sync user@home-server --all --restart

# switch this laptop to use the remote daemon
viberelay use remote user@home-server

# verify
viberelay status                       # talks to remote through tunnel
viberelay use show                     # mode: remote → user@home-server
```

Switch back with `viberelay use local`.

### "Same Gmail account spread over many ChatGPT teams; can't tell them apart"

Open `viberelay dashboard` → Account Settings → set a custom label per row (e.g. `Acme Team`, `client-foo prod`). Persists in settings, syncs across machines. Auto-derived label format `email · plan · #<account_id6>` is always shown when no override.

### "Set a 70/30 weighted split between Claude Sonnet and GPT-5.4"

Dashboard → Groups → Add or edit group → Strategy `weighted` → Models `claude-sonnet-4-5, gpt-5.4-reasoning-high` → Weights `70, 30`. Save. Failover on errors still walks the rest of the list.

## Things to avoid

- **Don't `rm -rf ~/.cli-proxy-api/`** — it'll wipe every authenticated account; users have to OAuth again. Use `viberelay sync ... --pull` from another machine to restore.
- **Don't run two viberelay daemons on the same machine on the same port** — `viberelay use remote` deliberately stops the local one before opening the tunnel; reverse with `viberelay use local`.
- **Don't bypass `cli-proxy-api`** to talk upstream APIs directly from the daemon — token refresh + account rotation lives there.
- **Don't sync `~/.claude.json`** automatically — it holds live session state; the `--claude` flag deliberately skips it.
- **Don't tag a release without bumping `package.json`** — CI keys release artifact names off the tag.

## Quick command reference

```
viberelay <command>
  start | stop | restart | status | logs [N]
  autostart enable | disable | status
  accounts
  usage [--once] [--watch] [--interval <ms>] [--json]
  dashboard [user@host]                 # local URL, or SSH tunnel a remote
  profile create|list|show|edit|delete|run [--dangerous]
    aliases:  p ls | p c | p e | p cat | p rm | run -d <name> | r <name>
  sync <user@host> [--pull] [--port N] [--dry-run] [--restart]
                  [--profiles] [--claude] [--all]
  use local | remote <user@host> | show | refresh
        [--ssh-port N] [--remote-port N] [--local-port N]
  openclaw setup | refresh | status | print [--set-default-model id] [--static]
  menubar install|uninstall|status         # macOS SwiftBar
  appindicator install|uninstall|status    # GNOME top-bar
  service install|uninstall|status         # daemon autostart
  update [--check] [--channel stable|nightly] [--force]
  --version | --help
```
