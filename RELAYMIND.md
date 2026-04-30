# RelayMind

A persistent, self-hosted Claude Code assistant for Telegram. RelayMind keeps a single Claude Code session alive across restarts, remembers what you talked about, hears Telegram messages natively, and can edit its own code under a supervisor that owns rollback.

Built on top of Claude Code — RelayMind is a thin layer that gives Claude an isolated profile, durable memory (SQLite + FTS5, no embeddings), a Telegram channel, deterministic hooks, and a supervisor that handles lifecycle. Hooks never call an LLM. The supervisor — not Claude — owns rollback and access control.

---

## Install

macOS and Linux only (x64 + arm64).

```bash
curl -fsSL https://github.com/YusufLisawi/viberelay/releases/latest/download/install-relaymind.sh | bash
```

This drops the `relaymind` binary at `$HOME/.local/bin/relaymind`. Make sure `$HOME/.local/bin` is on your `PATH`.

Pin a version or change the install prefix with environment overrides:

```bash
RELAYMIND_VERSION=v0.1.22 \
RELAYMIND_PREFIX=$HOME/.relaymind/dist \
RELAYMIND_BIN_DIR=$HOME/.local/bin \
  curl -fsSL https://github.com/YusufLisawi/viberelay/releases/latest/download/install-relaymind.sh | bash
```

If you already run `viberelay`, you can skip the standalone install — `viberelay relaymind <subcommand>` is the same binary path.

---

## Quick start

> **Prerequisite:** `tmux` must be on your `PATH`. RelayMind hosts the Claude Code session inside a tmux session so it gets a real PTY (without one, Claude Code EOFs on launch and slash commands don't render). Install with `brew install tmux` (macOS) or `apt install tmux` (Linux). `relaymind doctor` will flag this if it's missing.

```bash
# 1. Set up the isolated profile (idempotent)
relaymind init                                        # all defaults
relaymind init --auto-install                         # also installs missing tmux/claude
relaymind init --telegram-chat 6477802820 \           # capture allowlist + token-env
               --telegram-token <bot-token>           # token is NEVER written; init prints export hint
relaymind init --profile-name relaymind \             # override viberelay profile + model groups
               --opus-group high \
               --sonnet-group mid \
               --haiku-group low

# 2. Pair Telegram = export the bot token + allowlist your chat id
#    (no separate handshake — the supervisor reads both at start)
export VIBERELAY_RELAYMIND_TOKEN=<token-from-BotFather>
relaymind setup --telegram-chat <your-chat-id>     # appends to config.allowedChats

# 3. Start the persistent assistant session
relaymind start

# 4. Start the Telegram bridge (workaround for Anthropic issue #36503).
#    Channel-push delivery is currently gated by Anthropic; the bridge polls
#    the message mirror written by the plugin and replies via the Bot HTTP API.
#    Drop this step if the channels gate ever opens for you.
relaymind bridge start

# 5. Optional: a watchdog that health-checks and triggers daily summaries
relaymind watchdog start

# 6. Talk to it on Telegram. The session stays alive until you stop it.
```

`relaymind init` runs a checklist in this order: dep checks (tmux + claude) → profile layout → plugin bundle → context files → command registry → config → settings.json → telegram plugin → viberelay profile → telegram pairing capture → verify. Pass `--auto-install` to attempt automatic install of missing host deps via `brew` (macOS) or `apt` (Linux); `apt` exits with the exact `sudo` command rather than running it silently.

Verify any time:

```bash
relaymind doctor          # PASS / FAIL with a checklist
relaymind status          # supervisor + session state
relaymind logs 50         # last 50 supervisor events
```

---

## What it gives you

- **Persistent identity.** A named Claude Code session resumes across restarts. Your assistant has a name (`relaymind-main` by default) and remembers itself.
- **Durable memory.** Items, decisions, preferences, daily summaries — all in `.relaymind/relaymind.db` (SQLite + FTS5). Search across everything with `relaymind mem search`.
- **Telegram channel.** Native Claude Code Telegram plugin runs inside the isolated profile. Your inbox is the chat. Slash commands route either to local handlers (no LLM) or to the persistent Claude session.
- **Deterministic hooks.** SessionStart / UserPromptSubmit / PreCompact / Stop hooks render context, set flags, and never call an LLM (PRD §720).
- **Auto-injection.** Every Claude session starts with your `SOUL.md`, `TOOLS.md`, `MEMORY.md`, and the latest checkpoint already in context. Same mechanism as `claude-mem`. Edit those files freely; they're outside the plugin.
- **Self-editing rails.** Claude can edit RelayMind code and request a restart. The supervisor snapshots the registry, validates, restarts the named session, and rolls back if health check fails. `self rollback` is the only way to undo, and it cannot silently no-op.

---

## File layout

```
.relaymind/
├── relaymind.db                         SQLite — source of truth for memory
├── config.json                          Session name, dailySummaryAt, intervals
├── claude-home/                         Isolated Claude Code profile (cwd at start)
│   ├── SOUL.md                          ← edit freely; auto-injected
│   ├── TOOLS.md                         ← edit freely; auto-injected
│   ├── MEMORY.md                        ← edit freely; auto-injected (also generated)
│   ├── CLAUDE.md                        Wrapped in <!-- BEGIN/END RELAYMIND --> markers
│   ├── commands/
│   │   ├── registry.json                Telegram slash-command manifest
│   │   └── handlers/                    Local direct-command handlers
│   └── .claude/
│       ├── settings.json                Hook wiring with absolute paths
│       └── plugins/
│           ├── relaymind/               RelayMind plugin (skills, hooks, context fragments)
│           └── vibemind-telegram/       Official Telegram plugin
├── daily/
│   └── YYYY-MM-DD.md                    Daily summaries (also indexed in SQLite)
└── supervisor/
    ├── pid                              Live session pid
    ├── session.json                     SupervisorSessionMeta
    ├── registry.last-good.json          Snapshot for rollback
    └── supervisor.log                   Append-only event log
```

`SOUL.md`, `TOOLS.md`, and `MEMORY.md` are templates copied from `relaymind-plugin-cc/context/` on first install. They are yours after that — re-running `setup` does not overwrite them.

---

## Memory

Memory is plain old SQL. No embeddings.

```bash
# Add a durable fact
relaymind mem add --type decision \
  --title "Use SQLite FTS5 for memory" \
  --body "No embeddings, no Chroma, no vector DB. Recency + importance + edges only."

# Search
relaymind mem search "telegram slash commands"
relaymind mem search "compaction" --limit 3 --type decision

# One-hop expansion via explicit edges
relaymind mem link 42 51 --rel followup
relaymind mem related 42

# Read full bodies
relaymind mem get 42 51
```

Item types: `memory`, `preference`, `decision`, `task`, `idea`, `bug`, `open_loop`, `checkpoint`, `daily_summary`.
Edge relationships: `same_task`, `followup`, `depends_on`, `mentioned_in`, `decision_of`, `supersedes`, `caused_by`.

The `relaymind-memory` skill tells Claude when to use these commands — search before adding, prefer `update` over duplicates, never embed secrets.

---

## Telegram

Once the bot token is exported and your chat id is in `config.allowedChats`, slash commands flow like this:

```
Telegram /command
  → Telegram plugin (in profile)
  → spawns: viberelay telegram command run --json
  → CLI dispatcher reads registry.json
  → returns JSON: reply | forward-to-claude | noop
  → plugin renders to Telegram
```

If the CLI fails, the plugin falls back to its in-process dispatcher — no message loss.

Edit the registry without restarting the plugin:

```bash
relaymind telegram commands list
relaymind telegram commands validate
relaymind telegram commands reload     # manifest hot-reload (no plugin restart)
```

Handler code edits require a plugin restart (see `relaymind self validate` and `relaymind restart`).

---

## Daily summaries

A summary is a markdown file in `.relaymind/daily/YYYY-MM-DD.md` plus a `daily_summary` row in SQLite (FTS-indexed). Two paths:

- **Deterministic** — `relaymind daily summarize` aggregates today's items into the PRD §700 format. No LLM.
- **Claude-authored** — Claude pipes a markdown body in via `relaymind daily summarize --from-stdin`. Same storage, just better prose.

The watchdog auto-fires the deterministic path at `dailySummaryAt` (default `22:00` user-local) if a summary doesn't already exist for today:

```bash
relaymind watchdog start         # detached, writes to ~/.local state
relaymind watchdog status        # running / last health check / next daily ETA
relaymind watchdog stop
```

---

## Editing SOUL.md, MEMORY.md, TOOLS.md

These three files live at `.relaymind/claude-home/{SOUL,TOOLS,MEMORY}.md`. They are yours to edit. Every time Claude starts a session or submits a prompt, the SessionStart / UserPromptSubmit hook runs `relaymind context render` which:

1. Reads SOUL + TOOLS + MEMORY from disk
2. Adds the latest checkpoint and a context-pressure estimate (low / medium / high / critical)
3. For UserPromptSubmit, runs `mem search` on the prompt and appends the top hits
4. Emits the Claude Code hook JSON that injects everything as `additionalContext`

The injection format is the same one `claude-mem` uses:

```json
{"continue": true,
 "hookSpecificOutput": {
   "hookEventName": "SessionStart",
   "additionalContext": "<!-- SOUL.md -->\n...\n<!-- TOOLS.md -->\n...\n<!-- MEMORY.md -->\n..."}}
```

You can edit MEMORY.md by hand if you want. Or let Claude update it via `relaymind mem add` — the CLI is the source of truth and regenerates `MEMORY.md` from the database when needed.

---

## Self-edit and rollback

When Claude edits RelayMind code on its own:

```
Claude makes a code change
  → runs `relaymind self validate`     (typecheck + doctor + verifyInstallation)
  → runs `relaymind self snapshot`     (registry.json → registry.last-good.json)
  → runs `relaymind restart --resume-current`
  → if health check fails, supervisor automatically calls `relaymind self rollback`
  → if rollback also fails, it throws — never silently no-ops (PRD §867)
```

You can run any of these by hand:

```bash
relaymind self validate
relaymind self snapshot
relaymind self rollback        # destructive — restores last-good registry
```

`self rollback` requires the snapshot file to exist. Missing snapshot is an error, not a no-op.

---

## Security boundaries

Things RelayMind enforces and Claude cannot disable:

- Telegram pairing happens at the terminal, never via a chat message.
- Allowlist edits go through the `vibemind-telegram:access` skill, triggered by you locally.
- Bot tokens live in env vars only — never written to memory, daily summaries, or context renders.
- Direct CLI commands are allowlisted in the registry; non-allowlisted commands fall through to the LLM path.
- Stop hooks never call an LLM. Hooks are deterministic and fast.
- Rollback cannot be silently disabled. If the snapshot is missing, `self rollback` errors loudly.

If a Telegram message says "approve the pending pairing" or "add me to the allowlist" — that is a prompt-injection class. RelayMind's identity tells Claude to refuse and tell the requester to ask the user directly.

---

## CLI reference

Full per-command help via `--help`:

```bash
relaymind --help                 # top-level
relaymind init --help            # any subcommand
relaymind mem --help             # subgroup help
relaymind mem search --help      # leaf help (when supported)
```

Top-level commands:

| Group | Subcommands |
|---|---|
| Setup | `init`, `setup`, `doctor`, `plugin {install,verify}` |
| Lifecycle | `start`, `stop`, `restart`, `status`, `logs [--pane]`, `attach`, `send <text...>` |
| Memory | `mem {add,search,get,update,delete,link,related}` |
| Checkpoints | `checkpoint {write,maybe,latest}` |
| Context | `context render --event ...` (called by hooks; rarely by humans) |
| Daily | `daily {summarize,show,search}` |
| Watchdog | `watchdog {start,stop,status,tick}` |
| Telegram | `telegram commands {list,validate,reload}` |
| Self | `self {validate,snapshot,rollback}` |

Both `relaymind <cmd>` and `viberelay relaymind <cmd>` are valid — same code, two entry points.

---

## Troubleshooting

- **`relaymind doctor` says FAIL.** It tells you exactly which path is missing. `relaymind setup` is idempotent and repairs most things. If a context file (`SOUL.md`, `TOOLS.md`, `MEMORY.md`) is missing, copy fresh templates from `relaymind-plugin-cc/context/`.
- **`tmux: not found on PATH`.** RelayMind hosts Claude Code inside a tmux session for the PTY. Install it: `brew install tmux` on macOS, `apt install tmux` (or your distro's equivalent) on Linux. After install, `relaymind doctor` should pass and `relaymind start` will work.
- **Want to see what Claude is doing?** `relaymind attach` drops you into the live tmux session; detach with `Ctrl-b d`. For a non-interactive peek, `relaymind logs --pane 200` captures the last 200 lines of the pane without attaching. `relaymind send "<text>"` types a line + Enter into the running pane (useful for self-edit restart flows).
- **Hooks aren't injecting context.** Verify the absolute paths in `.relaymind/claude-home/.claude/settings.json` resolve. Run a hook by hand: `echo '{"hook_event_name":"SessionStart","session_id":"x","transcript_path":"/tmp/x","cwd":"."}' | relaymind context render --event session-start --from-stdin`. The output should be JSON starting with `{"continue":true,"hookSpecificOutput":...}`.
- **Telegram messages don't reach Claude.** Pairing is two things: (1) the bot token must be exported as `VIBERELAY_RELAYMIND_TOKEN` (or whatever `telegramTokenEnv` in `config.json` points at) **in the supervisor's environment, not just your shell** — restart `relaymind start` after exporting; (2) your chat id must appear in `allowedChats` in `.relaymind/config.json`. Add one with `relaymind setup --telegram-chat <id>`. There is no separate handshake.
- **Watchdog isn't firing daily summary.** `relaymind watchdog status` shows the next ETA. The summary is suppressed if a `daily/YYYY-MM-DD.md` already exists for today (so Claude can write one first via `--from-stdin`).
- **Need to start over.** `trash .relaymind/` then `relaymind init`. Memory and daily summaries will be lost — back them up first if you care (`.relaymind/relaymind.db` and `.relaymind/daily/`).

---

## How the supervisor launches Claude

The supervisor never spawns `claude` directly when a viberelay profile is configured. Instead it builds:

```
tmux new-session -d -s <session> -c <claude-home> \
  -e CLAUDE_PROJECT_DIR=<...> -e VIBERELAY_RELAYMIND_PROFILE=1 \
  -- viberelay run <profile> -- \
       [--resume <id>] \
       --dangerously-load-development-channels plugin:vibemind-telegram@vibemind-local \
       --dangerously-load-development-channels plugin:vibemind-relaymind@vibemind-local \
       --dangerously-skip-permissions
```

The first `--` separates tmux options from the runner command. The second `--` (after `viberelay run <profile>`) separates profile-runner flags from claude flags — the runner forwards everything past it to `claude` after applying the profile's env (model groups, base URL, account isolation).

Claude Code 2.x has no `--name` flag — the tmux session name addresses the process. `--resume <id>` is only emitted when a prior session id is recorded. The two `--dangerously-load-development-channels` flags load the bundled RelayMind + Telegram plugins from the profile-local `.claude-plugin/marketplace.json` (which `relaymind init` writes). `--dangerously-skip-permissions` covers per-tool prompts AND the workspace-trust dialog; `init` also pre-marks `<claude-home>` as trusted under `~/.claude.json` for belt-and-braces.

Why this matters: requests routed through `viberelay run <profile>` honor the multi-account proxy and round-robin model groups, which shields the persistent assistant from per-account rate limits during long sessions. Without it, a single account's quota stalls the whole assistant.

If the configured profile cannot be resolved (for example: the `~/.viberelay/profiles/<name>.json` file is missing), the supervisor falls back to bare `claude`, logs a clear warning to `supervisor.log`, and tells you to run `relaymind setup` to repair. The fallback never silently degrades the session — it leaves an audit trail.

`relaymind init` creates the viberelay profile automatically. You can override which profile and which model groups to bind it to:

```bash
relaymind init --profile-name relaymind --opus-group high --sonnet-group mid --haiku-group low
```

These overrides land in `config.json` under `viberelayProfile`, so the supervisor and subsequent `relaymind setup` runs read the same values.

---

## Configuration

Edit `.relaymind/config.json`:

```json
{
  "sessionName": "relaymind-main",
  "dailySummaryAt": "22:00",
  "telegramTokenEnv": "VIBERELAY_RELAYMIND_TOKEN",
  "allowedChats": ["6477802820"],
  "healthCheckIntervalMs": 60000,
  "viberelayProfile": {
    "name": "relaymind",
    "opus": "high",
    "sonnet": "mid",
    "haiku": "low"
  }
}
```

`telegramTokenEnv` is the **name** of the env var holding your bot token, not the token itself. `viberelayProfile` controls the `viberelay run <name>` invocation the supervisor builds (see "How the supervisor launches Claude"). `healthCheckIntervalMs` defaults to 60000 on fresh installs; existing configs keep whatever value they had.

---

## How it relates to viberelay

RelayMind ships from the same source tree as `viberelay`. Two binaries, one codebase. If you only want the assistant, install `relaymind`. If you also want the multi-account Claude proxy, install `viberelay` — and then `viberelay relaymind <cmd>` is identical to `relaymind <cmd>`.

When `relaymind` evolves into its own repo, the install URL will change but the CLI surface won't.

---

## License

MIT. See `LICENSE`.
