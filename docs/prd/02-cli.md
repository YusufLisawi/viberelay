# PRD: CLI (`packages/cli`)

## Purpose
`viberelay` CLI is primary user entrypoint. User must be able to operate VibeRelay fully from terminal even if dashboard never opens.

## Primary commands
- `viberelay start`
- `viberelay stop`
- `viberelay status`
- `viberelay dashboard`
- `viberelay usage`
- `viberelay accounts`
- `viberelay config`

## Command behavior
### `start`
- Start local backend/daemon
- Print health, port, and dashboard URL if enabled
- Avoid duplicate unhealthy instances

### `stop`
- Stop running backend cleanly
- Remove stale runtime state when safe

### `status`
- Show whether backend is running
- Show local URLs, PID, health, provider summary

### `dashboard`
- Ensure backend is reachable
- Print dashboard URL
- Optionally open browser

### `usage`
- Print usage summary by provider/account when available
- Clearly show unavailable or unsupported sources

### `accounts`
- Show connected accounts, enabled/disabled state, provider mapping

### `config`
- Show config path, runtime path, and key configuration summary

## UX requirements
- Human-readable output first
- Concise tables/lists
- Errors explain next step
- Future-ready for `--json`

## Non-goals for v1
- Complex interactive TUI
- Shell completion polish
- Remote multi-host orchestration

## Acceptance criteria
- User can run core flows without dashboard
- CLI output matches dashboard state
- Start/stop/status are reliable across repeated runs
