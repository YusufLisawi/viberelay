#!/usr/bin/env bash
# RelayMind PreCompact hook.
#
# Marks that a checkpoint is needed so the next Claude turn can write one
# (PRD §776). The hook itself never summarizes and never calls an LLM.
#
# Deterministic. No LLM call. Exit 0 on success.
set -euo pipefail
exec viberelay relaymind context render --event pre-compact --from-stdin
