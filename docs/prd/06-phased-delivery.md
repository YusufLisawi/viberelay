# PRD: Phased Delivery

## Phase 1 — Skeleton
- create package structure
- define shared contracts
- define runtime/state directories
- implement minimal daemon lifecycle
- implement `start`, `stop`, `status`

## Phase 2 — Core visibility
- provider registry skeleton
- account summary model
- usage summary model
- local API read endpoints
- `usage` and `accounts` CLI commands

## Phase 3 — Dashboard
- server-rendered dashboard shell
- status/accounts/usage/providers/model-groups sections
- polling and simple actions

## Phase 4 — Provider depth
- expand provider-specific auth/account handling
- expand usage support per provider
- tighten mutation flows and diagnostics

## Phase 5 — Packaging polish
- package bin setup
- install docs
- config migration/versioning
- stability hardening across repeated runs

## Definition of done for v1
- installable package exists
- `viberelay` commands work end-to-end
- local dashboard works
- core provider/account/model-group flows exist
- CLI and dashboard both expose usage summaries when available
