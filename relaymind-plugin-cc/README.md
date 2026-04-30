# vibemind-relaymind

RelayMind plugin bundle for Claude Code. Turns a Claude Code session running
inside an isolated `.relaymind/claude-home/` profile into a persistent
Telegram-connected assistant backed by the `viberelay relaymind` CLI.

## What it ships

- **skills/** — `relaymind-memory`, `relaymind-checkpoint`, `relaymind-daily`,
  `relaymind-self-heal`, `relaymind-commands`. Each skill tells Claude when
  and how to call the matching `viberelay relaymind ...` subcommand.
- **hooks/** — deterministic shell scripts for `SessionStart`,
  `UserPromptSubmit`, `PreCompact`, `Stop`. Hooks read the documented hook
  JSON from stdin and forward it to `viberelay relaymind context render`
  (or `checkpoint maybe`). Hooks never call an LLM.
- **context/** — `SOUL.md`, `TOOLS.md`, `MEMORY.md`, `CLAUDE.fragment.md`.
  These are RelayMind's identity, tool surface, rolling memory snapshot, and
  CLAUDE.md fragment.
- **settings.fragment.json** — JSON fragment merged into the isolated
  profile's `.claude/settings.json` to wire the four hooks and allowlist
  `viberelay` Bash invocations.

## Install

This plugin is published in the local `vibemind-local` marketplace at
`./.claude-plugin/marketplace.json`. Add the marketplace, then install:

```sh
/plugin marketplace add /Users/yusufisawi/Developer/viberelay
/plugin install vibemind-relaymind@vibemind-local
```

The `viberelay relaymind` profile installer (Agent H, see
`packages/cli/src/lib/profile-installer.ts`) is responsible for:

1. Copying the plugin payload into `.relaymind/claude-home/.claude/`.
2. Merging `settings.fragment.json` into `.claude/settings.json`.
3. Marking `hooks/*.sh` executable (`chmod +x`) — this repo cannot ship
   filesystem permission bits, so the installer must do it on copy.
4. Resolving the `${CLAUDE_PLUGIN_ROOT}` placeholder in
   `settings.fragment.json` to the absolute hook directory if the runtime
   does not expand it for us.

## Hook contract (D3)

Hooks read only these documented stdin JSON fields:

- `session_id`
- `transcript_path`
- `cwd`
- `hook_event_name`
- `prompt` (UserPromptSubmit only)

Anything else is best-effort. Hooks must exit 0 quickly; long-running or
LLM-bound work belongs in the next Claude turn, not the hook.

## Boundaries

- Hooks never invoke an LLM.
- `MEMORY.md` is updated only via `viberelay relaymind mem add` (CLI
  regenerates the file). Never hand-write it.
- Secrets (Telegram bot token, API keys) never enter memory.
- The supervisor — not Claude — owns rollback and restart. `viberelay
  relaymind self rollback` is destructive and requires explicit user intent.
