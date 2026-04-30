#!/usr/bin/env bash
# RelayMind UserPromptSubmit hook.
#
# Forwards the stdin hook payload (includes `prompt`) to the CLI, which
# performs an FTS memory search, gathers active goals / open loops, and
# injects compact context for the upcoming turn.
#
# Deterministic. No LLM call. Exit 0 on success.
set -euo pipefail
exec viberelay relaymind context render --event user-prompt --from-stdin
