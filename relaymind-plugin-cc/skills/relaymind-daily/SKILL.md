---
name: relaymind-daily
description: Produce or recall RelayMind daily summaries via viberelay relaymind daily. Use when the supervisor signals a daily summary is due (default 22:00 local), when the user asks "what did we do today", "/daily", or wants to inspect a past day. Daily summaries are written by the persistent Claude session, never by hooks.
when-to-use: |
  - Supervisor scheduled a daily summarize event
  - User runs `/daily` from Telegram
  - User asks "summarize today", "what changed today", "recap this week"
  - End-of-day before stopping the persistent session
when-not-to-use: |
  - Mid-day arbitrary status check (use `mem search` or `checkpoint latest`)
  - Inside any hook (hooks must not invoke this skill)
  - When no meaningful work has happened since the last summary
allowed-tools:
  - Bash(viberelay relaymind daily *)
  - Bash(viberelay relaymind mem *)
  - Bash(viberelay relaymind checkpoint latest)
---

# relaymind-daily

Daily summaries are persisted in SQLite (`type=daily_summary`, FTS-indexed)
and rendered to `.relaymind/daily/YYYY-MM-DD.md`. SQLite is the source of
truth; the markdown is a human-friendly artifact.

## Generate today's summary

```bash
viberelay relaymind daily summarize
```

Before you call it, gather material:

```bash
viberelay relaymind checkpoint latest
viberelay relaymind mem search "$(date +%Y-%m-%d)" --limit 20
viberelay relaymind mem search "<topic of the day>" --limit 10
```

Compose the summary in the documented shape:

```md
# Daily Summary — YYYY-MM-DD

## Done
- ...

## Decisions
- ...

## Open Loops
- ...

## Next
- ...
```

`viberelay relaymind daily summarize` accepts the body via the CLI's prompt
and stores it through the memory layer.

## Read past summaries

```bash
viberelay relaymind daily show          # today
viberelay relaymind daily show 2026-04-26
viberelay relaymind daily search "<query>"
```

## Decision flow

1. Pull the latest checkpoint and any same-day memories.
2. Draft a terse summary — bullets, no narrative filler.
3. Write via `viberelay relaymind daily summarize`.
4. If new durable decisions surfaced during composition, also call the
   memory skill to record them as `decision` items.

## Hard rules

- Never call from a hook.
- Never invent activity. If `Done` would be empty, say "_(quiet day)_".
- Do not include secrets.
