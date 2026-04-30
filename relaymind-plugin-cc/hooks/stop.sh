#!/usr/bin/env bash
# RelayMind Stop hook.
#
# 1. Asks the CLI whether a checkpoint should be persisted (idempotent,
#    deterministic — does not invoke an LLM; the next Claude turn finalizes
#    any structured summary).
# 2. Renders the stop-event context so the CLI can update session/idle
#    markers and trim transcripts.
#
# Deterministic. No LLM call. Exit 0 on success.
set -euo pipefail

# Capture stdin once so we can reuse it for both subcommands.
PAYLOAD="$(cat || true)"

printf '%s' "$PAYLOAD" | viberelay relaymind checkpoint maybe --from-stdin || true
printf '%s' "$PAYLOAD" | viberelay relaymind context render --event stop --from-stdin
