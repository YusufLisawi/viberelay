# PRD: RelayMind

## Summary

RelayMind is a minimalist, self-hosted Claude Code assistant for Telegram. It uses a persistent Claude Code session as the intelligent assistant, a local supervisor CLI as the control plane, and a bundled Claude Code plugin to provide identity, memory, tools, hooks, and setup automation.

The goal is to create an OpenClaw-like assistant experience while keeping Claude Code as the core runtime and preserving native Claude Code capabilities, including channels, media handling, skills, hooks, subagents, and repo editing.

## Name

Recommended name: **RelayMind**

Why:
- Connects naturally to `viberelay`.
- Signals a persistent assistant with memory.
- Does not frame the product as an OpenClaw clone.
- Works for Telegram now and other channels later.

Alternates:
- **VibeMind**
- **ClawRelay**
- **MemoRelay**
- **RelaySoul**

## Problem

Power users want a persistent Telegram-based Claude Code assistant that can:

- receive Telegram messages through Claude Code channels
- preserve identity and memory across restarts
- self-heal and reconnect to the same Claude session
- expose Telegram slash commands
- run direct machine commands without unnecessary LLM calls
- route complex commands into Claude Code when needed
- improve its own code, commands, and memory system safely
- keep a searchable, accurate record of work without embeddings or heavy services

Existing approaches either put too much in the LLM, require too many services, or do not integrate deeply enough with Claude Code's native harness.

## Goals

1. Provide a one-command setup flow for a Telegram-connected Claude Code assistant.
2. Use Claude Code's native Telegram channel/plugin for the main assistant conversation.
3. Provide a supervisor CLI that can start, stop, restart, resume, inspect, and repair the assistant.
4. Bundle a Claude Code plugin that installs skills, hooks, identity files, memory files, and settings.
5. Support Telegram slash commands that can be either:
   - direct machine commands, with no LLM call
   - LLM-routed commands, handled by the persistent Claude Code assistant
6. Implement a lightweight memory system using SQLite FTS5 and explicit relationships, with no embeddings.
7. Maintain `MEMORY.md` as a compact injected memory snapshot that Claude Code can update when appropriate.
8. Generate daily markdown summaries at `.relaymind/daily/YYYY-MM-DD.md` using the Claude Code assistant itself, not hook-triggered LLM calls.
9. Allow Claude Code to edit RelayMind code and command definitions, while supervisor restart/rollback remains deterministic.

## Non-goals

- No embeddings in the MVP.
- No Chroma or vector database in the MVP.
- No MCP-first architecture.
- No LLM calls from Stop hooks.
- No autonomous Telegram allowlist or pairing changes by Claude.
- No autonomous deployment, pushing, or destructive filesystem actions.
- No fork of the Telegram plugin unless the native plugin blocks required behavior.
- No broad multi-channel support in MVP; Telegram only.

## Target User

A technical user who already uses Claude Code and wants a persistent Telegram assistant that can manage coding tasks, memory, daily summaries, and self-improvement on their own machine or server.

## Core Architecture

```txt
RelayMind CLI / supervisor
  ├─ installs and configures Telegram integration
  ├─ installs Claude Code plugin files
  ├─ manages environment paths and settings
  ├─ starts native Claude Code Telegram session
  ├─ handles direct Telegram commands when possible
  ├─ watches health and reconnects sessions
  ├─ owns memory database and command registry
  └─ restarts / rolls back safely

Claude Code persistent session
  ├─ receives normal Telegram messages natively
  ├─ handles media using Claude Code channel capabilities
  ├─ follows injected identity/soul/memory/tool context
  ├─ uses skills to call RelayMind CLI
  ├─ updates memory when appropriate
  ├─ summarizes daily work when asked/scheduled by supervisor
  └─ can edit RelayMind code and request restart
```

## Installation and Setup Flow

The user installs the CLI:

```bash
relaymind install
```

or through the host project:

```bash
viberelay relaymind install
```

The setup wizard handles:

1. Detecting Claude Code installation.
2. Creating an isolated RelayMind-managed Claude Code profile/runtime.
3. Detecting or installing required `viberelay` support.
4. Installing and configuring the official Claude Code Telegram plugin/channel integration.
5. Installing the RelayMind Claude Code plugin bundle.
6. Asking for Telegram bot token or locating existing Telegram plugin config.
7. Preparing `.env` and all paths required by the Telegram plugin.
8. Running Telegram pairing outside Claude Code.
9. Writing allowlisted chat IDs and local identity configuration.
10. Installing RelayMind-owned Claude Code skills.
11. Installing RelayMind-owned Claude Code hooks.
12. Creating `SOUL.md`, `MEMORY.md`, `TOOLS.md`, and a RelayMind-controlled `CLAUDE.md`.
13. Preconfiguring the profile to use `viberelay` logic and RelayMind defaults.
14. Starting or resuming the named Claude Code assistant session.

Claude Code does not perform Telegram pairing. Pairing is a deterministic CLI setup step.

## Isolated Claude Code Profile

RelayMind should not mutate the user's normal Claude Code environment.

Setup creates a fresh, isolated Claude Code profile/runtime owned by RelayMind. This profile contains only RelayMind-approved configuration, skills, hooks, memory files, Telegram settings, and `viberelay` defaults.

The isolated profile must include:

```txt
.relaymind/claude-home/
  CLAUDE.md
  settings.json
  skills/
  hooks/
  plugins/
  SOUL.md
  MEMORY.md
  TOOLS.md
```

Requirements:

- RelayMind controls this profile's `CLAUDE.md` without risking or overwriting the user's existing `CLAUDE.md`.
- RelayMind installs all required skills/plugins/hooks inside this profile.
- RelayMind installs/configures the official Telegram plugin/channel integration inside this profile.
- RelayMind configures the profile to work with `viberelay` out of the box.
- RelayMind starts Claude Code with environment variables or flags that point to this isolated profile when supported.
- If Claude Code does not support fully separate profile paths, RelayMind must emulate isolation by using a dedicated working directory, dedicated settings files, and explicit startup flags.
- The user's existing Claude Code sessions, skills, hooks, and project instructions must remain untouched unless the user explicitly requests integration.

This makes the assistant reproducible, controllable, and safe to repair or reset.

## Runtime Start Flow

```bash
relaymind start
```

The supervisor:

1. loads config
2. verifies Telegram plugin environment
3. verifies memory database
4. verifies Claude Code settings/hooks/skills
5. starts required relay services
6. starts Claude Code with a stable session name
7. passes native Telegram channel args
8. records process/session metadata
9. begins health monitoring

Example conceptual command:

```bash
claude --name relaymind-main \
  --channels plugin:telegram@telegram \
  --with relaymind
```

Resume flow:

```bash
relaymind restart --resume-current
```

The supervisor must resume the same named session whenever possible.

## Telegram Integration

### Native conversation path

Normal Telegram messages go through Claude Code's native Telegram channel.

```txt
Telegram message
  -> native Claude Code Telegram channel
  -> persistent Claude Code session
  -> Claude response
  -> Telegram reply
```

This preserves native media handling and the normal Claude Code assistant experience.

### Direct command path

Some Telegram slash commands should bypass the LLM.

```txt
Telegram /usage
  -> RelayMind direct command handler
  -> local machine command
  -> Telegram reply
```

RelayMind uses the Telegram plugin as a stable transport/access/MCP shell. The marketplace plugin remains publishable and read-only for command business logic.

Slash command behavior lives in the isolated RelayMind Claude profile and is executed by the RelayMind/VibeMind CLI. When the plugin sees a Telegram slash command, it serializes Telegram context to JSON and calls:

```bash
vibemind telegram command run --json
```

or the repo-local development equivalent:

```bash
viberelay telegram command run --json
```

The CLI reads the profile-owned command registry and handlers, then returns JSON telling the plugin whether to reply directly, forward a prompt to Claude, or fall back to normal message forwarding.

This means adding or editing command definitions does not require modifying or reinstalling the marketplace plugin. Registry changes are visible on the next command invocation. Handler changes are owned by the profile CLI layer and can be validated/reloaded independently.

## Telegram Command Registry

RelayMind maintains an editable command registry inside the isolated RelayMind Claude profile, not inside the marketplace Telegram plugin.

The current local Telegram plugin already parses a small hardcoded set of bot commands (`/start`, `/help`, `/status`). RelayMind should replace this with a generic command dispatcher:

```txt
Telegram text message
  -> parse leading /command
  -> check access policy
  -> lookup command manifest
  -> execute direct handler or emit LLM-routed event
  -> reply or forward to Claude
```

Command definitions should live outside `server.ts`, for example:

```txt
.relaymind/claude-home/commands/
  registry.json
  handlers/
    usage.ts
    status.ts
    restart.ts
```

Command types:

### Direct commands

Run deterministic local logic and return output without an LLM call.

Examples:

```txt
/ping
/status
/usage
/logs
/restart
/sessions
```

### LLM-routed commands

Send structured instructions to the persistent Claude Code session.

Examples:

```txt
/fix <issue>
/build <feature>
/remember <fact>
/daily
/self-improve
```

### Command definition

```ts
type TelegramCommand = {
  name: string;
  description: string;
  mode: "direct" | "llm";
  risk: "read" | "write" | "external" | "destructive";
  enabled: boolean;
  handler: string;
  allowedChats: string[];
  requiresApproval: boolean;
  reload: "manifest" | "plugin-restart";
};
```

### Direct handler contract

Direct handlers should be small modules with a stable interface:

```ts
type DirectCommandHandler = (ctx: {
  text: string;
  args: string[];
  chatId: string;
  userId?: string;
  stateDir: string;
}) => Promise<{
  text: string;
  files?: string[];
}>;
```

Handlers run through the RelayMind/VibeMind CLI and may call allowlisted local commands. The Telegram plugin only passes Telegram context and renders the CLI result.

## Editable Commands

Claude Code may add or edit Telegram command definitions through the RelayMind CLI.

Preferred flow for new commands:

```txt
Claude creates/edits profile-owned command manifest
  -> optionally creates a direct handler file under .relaymind/claude-home/commands/handlers/
  -> runs relaymind telegram commands validate
  -> runs CLI tests/typecheck
  -> command becomes available on the next invocation if manifest-only
  -> handler changes are picked up by the CLI command layer without reinstalling the Telegram plugin
```

Hot update modes:

- Manifest-only commands are reloadable without restarting the plugin.
- Direct command handler changes are owned by the CLI command layer, not the Telegram plugin.
- Transport/access/bootstrap changes require full supervisor restart and rollback protection.

Rollback:

```txt
health check fails
  -> supervisor restores last known good registry/handlers
  -> restarts Telegram plugin if needed
  -> resumes Claude session
  -> reports failure
```

Claude may freely edit:

- profile-owned command manifests
- command prompt templates
- direct handlers in `.relaymind/claude-home/commands/handlers/`
- command tests

Claude may not silently modify:

- `server.ts` transport/access hot path
- Telegram pairing state
- Telegram allowlist
- secrets
- permission policy
- rollback mechanism
- supervisor safety checks

## CLI Design

Primary namespaces:

```bash
relaymind init
relaymind setup
relaymind start
relaymind stop
relaymind restart
relaymind status
relaymind logs
relaymind doctor

relaymind telegram setup
relaymind telegram pair
relaymind telegram status
relaymind telegram commands list
relaymind telegram commands add
relaymind telegram commands validate
relaymind telegram commands reload

relaymind mem add
relaymind mem search
relaymind mem get
relaymind mem update
relaymind mem delete
relaymind mem link
relaymind mem related

relaymind checkpoint write
relaymind checkpoint maybe
relaymind checkpoint latest

relaymind daily summarize
relaymind daily show
relaymind daily search

relaymind context render
relaymind plugin install
relaymind plugin verify
relaymind self validate
relaymind self rollback
```

The CLI is the source of truth for setup, memory, commands, and lifecycle.

Skills are thin wrappers that tell Claude Code when and how to call the CLI.

## Plugin Bundle

RelayMind ships a Claude Code plugin bundle containing:

```txt
skills/
  relaymind-memory/
  relaymind-checkpoint/
  relaymind-daily/
  relaymind-self-heal/
  relaymind-commands/

hooks/
  session-start
  user-prompt-submit
  pre-compact
  stop

context/
  SOUL.md
  MEMORY.md
  TOOLS.md
  CLAUDE.fragment.md
```

The plugin installer adds these to the correct Claude Code paths and updates settings safely.

## Context Files

### `SOUL.md`

Stable assistant identity and behavioral style.

Always injected.

### `TOOLS.md`

Available CLI commands, skills, safety rules, and operational guidance.

Always injected.

### `MEMORY.md`

Compact rolling memory snapshot.

Always injected, but kept short.

Contains:

```md
# Active Goals
# Open Loops
# Recent Decisions
# User Preferences
# Current Assistant State
# Last Checkpoint
```

### `CLAUDE.md`

The Claude Code instance should know it is RelayMind.

It should explain:

- this is a persistent Telegram assistant
- RelayMind CLI owns setup, memory, commands, and lifecycle
- skills are available for memory/checkpoint/daily/self-heal
- Claude should update memory only when durable information changes
- Claude should not treat hooks as a place to run LLM work

`CLAUDE.md` is not a security boundary. Protected rules should be enforced by the supervisor.

## Memory System

RelayMind uses SQLite and FTS5 only. No embeddings.

### Source of truth

SQLite database:

```txt
.relaymind/relaymind.db
```

### Human-readable artifacts

```txt
.relaymind/MEMORY.md
.relaymind/daily/YYYY-MM-DD.md
```

SQLite remains the source of truth. Markdown files are generated snapshots/artifacts.

## Memory Schema

### `items`

```sql
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT,
  day TEXT NOT NULL,
  importance INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Types:

```txt
memory
preference
decision
checkpoint
daily_summary
task
idea
bug
open_loop
```

### `items_fts`

```sql
CREATE VIRTUAL TABLE items_fts USING fts5(
  title,
  body,
  source,
  content='items',
  content_rowid='id'
);
```

### `edges`

```sql
CREATE TABLE edges (
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  rel TEXT NOT NULL,
  weight INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);
```

Relationships:

```txt
same_task
followup
depends_on
mentioned_in
decision_of
supersedes
caused_by
```

Relationships are sparse and explicit. No automatic dense graph generation in MVP.

## Memory Search

Search flow:

```txt
query
  -> SQLite FTS top matches
  -> exact phrase/title boost
  -> recency boost
  -> importance boost
  -> one-hop relationship expansion
  -> compact ranked results
```

Example:

```bash
relaymind mem search "telegram slash commands"
```

Returns:

```txt
[42] decision 2026-04-27 Use editable Telegram command registry
[51] idea     2026-04-27 Direct commands bypass LLM
[58] daily    2026-04-27 Daily summary: Telegram assistant architecture
```

Then:

```bash
relaymind mem get 42 51 58
```

## `MEMORY.md` Sync Rules

`MEMORY.md` is a compact generated and editable snapshot, not a raw log.

It should be updated when:

- a durable user preference is learned
- a major project decision is made
- an active goal changes
- an open loop is created or closed
- the assistant identity/lifecycle state changes
- a checkpoint determines that the rolling memory is stale

It should not be updated for:

- every message
- temporary implementation details
- raw command output
- transient errors that are already resolved
- facts derivable from code or git history

Claude Code can update `MEMORY.md` by using the RelayMind memory skill/CLI:

```bash
relaymind mem add --type decision --title "..." --body "..."
relaymind context rebuild-memory-md
```

The CLI writes memory records to SQLite and regenerates `MEMORY.md`.

## Checkpoints

Checkpoints are structured summaries of meaningful work intervals.

They are stored in SQLite as `type=checkpoint`.

A checkpoint includes:

```md
## What happened
## Decisions
## Open loops
## Next actions
## Memory updates needed
```

Claude Code should create checkpoints at natural boundaries:

- after finishing a meaningful task
- before restarting itself
- before large refactors
- before context becomes risky
- before daily summarization

Hooks may request or record that a checkpoint is needed, but hooks must not make LLM calls.

## Daily Summaries

Daily summaries are generated by the persistent Claude Code assistant, not by Stop hooks.

Supervisor flow:

```txt
scheduled daily summarize event
  -> supervisor asks persistent Claude session to summarize the day
  -> Claude uses relaymind mem search/get and checkpoint latest
  -> Claude writes summary through relaymind daily summarize/write
  -> CLI stores summary in SQLite
  -> CLI writes .relaymind/daily/YYYY-MM-DD.md
```

Output file:

```txt
.relaymind/daily/2026-04-27.md
```

Format:

```md
# Daily Summary — 2026-04-27

## Done
- ...

## Decisions
- ...

## Open Loops
- ...

## Next
- ...
```

The daily summary is also inserted into SQLite as `type=daily_summary` and indexed by FTS.

## Hook Policy

Hooks are deterministic and fast.

### Allowed hook behavior

- read static context files
- render compact context
- log transcript metadata
- set checkpoint-needed flags
- persist non-LLM state
- run lightweight CLI checks

### Forbidden hook behavior

- calling Claude or any LLM
- long-running summarization
- editing source code
- changing Telegram allowlists
- restarting the whole system without explicit supervisor flow

## Hook Design

### `SessionStart`

Runs:

```bash
relaymind context render --event session-start
```

Injects:

- `SOUL.md`
- `TOOLS.md`
- `MEMORY.md`
- latest checkpoint
- assistant status
- approximate context estimate

### `UserPromptSubmit`

Runs:

```bash
relaymind context render --event user-prompt --prompt "$PROMPT"
```

Injects:

- relevant memory search results
- active goals
- open loops
- current command registry summary
- context estimate

### `PreCompact`

Runs:

```bash
relaymind checkpoint mark-needed --reason pre-compact
```

No LLM call. The next Claude turn should perform the checkpoint.

### `Stop`

Runs:

```bash
relaymind checkpoint mark-needed --reason stop
relaymind session mark-idle
```

No LLM call.

## Context Usage and Compaction

RelayMind cannot depend on exact Claude Code context remaining unless Claude Code exposes it.

Claude Code does not currently expose a reliable documented `compact now` CLI, slash command, hook, or tool API that RelayMind can depend on. RelayMind should assume compaction is automatic and outside its direct control.

Instead, the CLI estimates context pressure from:

- transcript file size
- number of messages since last checkpoint
- last known compaction or restart marker if observable
- checkpoint age
- recent large tool outputs

Injected field:

```txt
context_estimate: low | medium | high | critical
recommendation: continue | checkpoint soon | checkpoint now | avoid large reads
```

Claude Code uses this to manage context efficiently.

RelayMind's strategy is checkpoint-before-risk, not trigger-compaction-directly:

```txt
context pressure rises
  -> hook marks checkpoint needed
  -> context injection tells Claude to checkpoint soon/now
  -> Claude writes checkpoint through RelayMind CLI during a normal turn
  -> important state is externalized before automatic Claude Code compaction happens
```

If Claude Code later exposes a stable compaction command/API, RelayMind may add optional support, but the product must work without it.

## Self-Editing and Self-Healing

Claude Code may improve RelayMind code, commands, and docs.

Safe self-update flow:

```txt
Claude edits RelayMind code
  -> runs tests/typecheck
  -> runs relaymind self validate
  -> writes checkpoint
  -> calls relaymind restart --resume-current
  -> supervisor snapshots last known good version
  -> supervisor restarts services
  -> supervisor resumes same Claude session
  -> health check passes or rollback occurs
```

Supervisor-owned self-healing:

- restart crashed Claude process
- reconnect Telegram plugin
- restart relay service
- restore command registry from last known good version
- resume named Claude Code session
- report failure to Telegram

Claude-owned self-healing:

- diagnose failures
- patch code
- update tests
- update commands
- update memory/checkpoints
- request restart through CLI

## Security and Permissions

Hard boundaries:

- Telegram pairing is outside Claude.
- Telegram allowlist edits require deterministic CLI/admin approval.
- Secrets are never written to memory or daily summaries.
- Direct machine commands are allowlisted.
- LLM-routed commands are auditable.
- Destructive actions require explicit user approval.
- Supervisor rollback cannot be disabled by Claude without approval.

## MVP Scope

### Phase 1: CLI and memory core

- `relaymind init`
- SQLite schema
- `mem add/search/get/link/related`
- `MEMORY.md` generation
- `SOUL.md`, `TOOLS.md`, `CLAUDE.fragment.md`

### Phase 2: Isolated Claude Code profile and plugin installer

- create RelayMind-managed Claude Code profile/runtime
- install official Claude Code Telegram plugin/channel integration
- install RelayMind plugin bundle
- install RelayMind-owned skills
- install RelayMind-owned hooks
- install RelayMind-controlled `CLAUDE.md`
- configure profile-local settings
- verify paths
- preconfigure `viberelay` defaults
- render context on SessionStart/UserPromptSubmit

### Phase 3: Telegram setup

- Telegram bot token setup
- pairing outside Claude
- env/path configuration for Telegram plugin
- start native Claude Code Telegram session
- resume existing session

### Phase 4: Command registry

- refactor local Telegram plugin to use a generic slash-command dispatcher
- add `telegram-plugin-cc/commands/registry.json`
- add `telegram-plugin-cc/commands/handlers/`
- direct `/status`, `/usage`, `/logs`
- LLM-routed `/fix`, `/build`, `/daily`
- command validation and reload
- plugin-only restart for handler changes

### Phase 5: Daily summaries

- supervisor daily trigger
- Claude-routed daily summarization
- `.relaymind/daily/YYYY-MM-DD.md`
- index summary back into SQLite FTS

### Phase 6: Self-healing

- watchdog
- restart/resume
- last-known-good command registry
- self-update validation
- rollback

## Success Criteria

- A user can install RelayMind and complete Telegram setup without manually editing plugin paths.
- RelayMind creates an isolated Claude Code profile/runtime without mutating the user's existing Claude Code configuration.
- The isolated profile is preconfigured with the official Telegram plugin, RelayMind plugin bundle, skills, hooks, `CLAUDE.md`, memory files, and `viberelay` defaults.
- A persistent Claude Code session receives Telegram messages through the native Telegram channel.
- `/status` and `/usage` can return without an LLM call once direct command interception is implemented.
- Claude Code always receives compact injected identity, tools, memory, and relevant retrieval context.
- `MEMORY.md` updates only for durable state, not every message.
- Daily summaries are generated into `.relaymind/daily/YYYY-MM-DD.md` and are searchable.
- Memory search can answer "what did we do about X?" using SQLite FTS and relationship links.
- Stop hooks never call an LLM.
- Claude can edit RelayMind code and request restart, while supervisor can rollback if health checks fail.

## Open Questions

1. Should direct command handling be implemented with per-command manifest reload, plugin process restart, or both?
2. What is the safest way for RelayMind supervisor to restart only the local Telegram plugin process without killing the Claude session?
3. Should the package name be `relaymind`, `vibemind`, or integrated as `viberelay assistant`?
4. Should daily summarization run at a fixed local time or be triggered by assistant idle state?
5. What exact Claude Code hook payload fields are stable enough to rely on for transcript paths and session IDs?
6. What is the best supported way to run Claude Code with an isolated profile/home/settings directory?
7. Which `viberelay` profile and defaults should RelayMind install into its isolated Claude Code runtime?
