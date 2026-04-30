---
name: relaymind-checkpoint
description: Externalize a structured snapshot of recent work into RelayMind via viberelay relaymind checkpoint. Use after finishing a meaningful task, before a large refactor, before restarting the supervisor, or when the latest context render reports recommendation=checkpoint-now / context_estimate=high|critical. Hooks may flag a checkpoint as needed but only this skill (running on a Claude turn) writes them.
when-to-use: |
  - You just finished a meaningful task or milestone
  - About to run a destructive or wide-blast-radius change
  - About to restart the supervisor or the persistent session
  - Context render reports `recommendation: checkpoint now` or `checkpoint soon`
  - PreCompact / Stop hook fired and `checkpoint maybe` decided one is due
  - The user says "checkpoint", "save state", "snapshot where we are"
when-not-to-use: |
  - Mid-task, when more work is expected within the same logical unit
  - Purely exploratory turns with no decisions, no diffs, no open-loop changes
  - As a substitute for `mem add` on a single durable fact (use the memory skill)
allowed-tools:
  - Bash(viberelay relaymind checkpoint *)
  - Bash(viberelay relaymind context *)
  - Bash(viberelay relaymind mem search *)
  - Bash(viberelay relaymind mem get *)
---

# relaymind-checkpoint

A checkpoint is a structured summary of a meaningful work interval. It is
stored in SQLite as `type=checkpoint` and surfaced by
`viberelay relaymind checkpoint latest` plus the `SessionStart` context
render.

## Format

```md
## What happened
## Decisions
## Open loops
## Next actions
## Memory updates needed
```

## Commands

```bash
# Write a checkpoint right now (you supply the content via the CLI prompt).
viberelay relaymind checkpoint write

# Heuristic: writes only if conditions warrant (age, message volume, flags).
viberelay relaymind checkpoint maybe

# Print the most recent checkpoint (read-only, safe).
viberelay relaymind checkpoint latest
```

`checkpoint maybe` is also invoked by the Stop hook so a Claude turn can
finalize. It is idempotent and cheap — calling it on every meaningful turn
boundary is fine.

## Decision flow

1. Run `viberelay relaymind checkpoint latest` to see the prior state.
2. Decide whether enough new ground was covered to warrant a checkpoint.
3. If yes: `viberelay relaymind checkpoint write` and fill the five sections
   tersely. Reference memory item ids with `[<id>]` where possible.
4. After writing, if the checkpoint surfaces durable facts, hand them to the
   memory skill — `mem add` does not happen automatically.

## Hard rules

- Hooks must not write checkpoints — only Claude turns do. PreCompact/Stop
  hooks may set a `checkpoint-needed` flag; the next turn drains it.
- Do not paste full transcripts. A checkpoint is a digest, not a log.
- Never include secrets in the body.
