---
name: relaymind-memory
description: Persist durable RelayMind memory through the viberelay relaymind mem CLI — preferences, decisions, goals, open loops, ideas, bugs. Use when the user says "remember this", "note for later", "we decided", "from now on", "open loop", "track this", or when a major project decision/preference emerges that should survive restarts. Do NOT use for transient implementation chatter or facts derivable from git/code.
when-to-use: |
  - User says "remember", "save this", "note this down", "from now on", "always", "never"
  - A durable preference is learned (tooling choice, voice, defaults)
  - A major decision is made (architecture, naming, schema)
  - An active goal is added or closed
  - An open loop is opened or resolved
  - You need to recall prior decisions before answering ("did we decide…?")
when-not-to-use: |
  - Transient implementation details that will be obvious from the next diff
  - Raw command output or stack traces already resolved
  - Secrets, tokens, or credentials (never write these to memory)
  - Per-message logging — MEMORY.md is durable state, not a transcript
allowed-tools:
  - Bash(viberelay relaymind mem *)
  - Bash(viberelay relaymind context *)
---

# relaymind-memory

You are RelayMind. Your durable memory is SQLite at
`.relaymind/relaymind.db` (FTS5 indexed) and a regenerated snapshot at
`.relaymind/MEMORY.md`. All access goes through the CLI — never edit the DB
or the markdown by hand; the CLI rebuilds the snapshot from SQLite.

## Item types

`memory`, `preference`, `decision`, `task`, `idea`, `bug`, `open_loop`.
(`checkpoint` and `daily_summary` are owned by other skills.)

## Add a memory

```bash
viberelay relaymind mem add \
  --type <type> \
  --title "<short title>" \
  --body "<one to a few paragraphs>" \
  [--source "<where this came from>"] \
  [--importance <0-5>]
```

Pick `--importance 3+` only for things that should survive every compaction
(stable preferences, top-level decisions). Default to 1 for routine notes.

## Search before adding

Always search first to avoid duplicates:

```bash
viberelay relaymind mem search "<query>" [--limit 5] [--type decision]
```

If a near-duplicate exists, prefer `mem update` over a new entry:

```bash
viberelay relaymind mem update <id> [--title T] [--body B] [--importance N]
```

## Inspect and link

```bash
viberelay relaymind mem get <id> [<id> ...]
viberelay relaymind mem link <fromId> <toId> --rel <rel>
viberelay relaymind mem related <id>
```

Valid `--rel` values: `same_task`, `followup`, `depends_on`, `mentioned_in`,
`decision_of`, `supersedes`, `caused_by`. Keep edges sparse and explicit.

## Decision flow

1. Decide whether the fact is durable. If not, drop it.
2. `mem search` for an existing entry.
3. `mem add` (or `mem update` if updating).
4. If it relates to an existing item, `mem link` once.
5. Do not touch `MEMORY.md` — the CLI regenerates it on the next render.

## Hard rules

- Never include secrets, tokens, or credentials.
- Never edit `MEMORY.md` directly.
- Never add memory for facts that are obvious from `git log` or current code.
- One memory per durable concept — keep titles unique and searchable.
