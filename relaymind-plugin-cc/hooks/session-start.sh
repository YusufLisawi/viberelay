#!/usr/bin/env bash
# RelayMind SessionStart hook.
#
# Reads the documented Claude Code hook payload from stdin (DECISIONS.md §D3:
# session_id, transcript_path, cwd, hook_event_name) and forwards it to the
# CLI context renderer, which injects SOUL.md / TOOLS.md / MEMORY.md / latest
# checkpoint / context_estimate.
#
# Deterministic. No LLM call. Exit 0 on success.
set -euo pipefail
exec viberelay relaymind context render --event session-start --from-stdin
