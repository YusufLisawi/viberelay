# PRD: Storage, Runtime, and Local API

## Purpose
VibeRelay needs reliable local persistence and local process control that work across macOS, Linux, and Windows.

## Persistence requirements
Need portable locations for:
- config
- accounts state
- provider settings
- model groups
- runtime metadata
- PID or daemon connection state
- logs/diagnostics

## Runtime requirements
- one backend process at a time
- reliable start/stop/status
- no orphaned process buildup
- local health endpoint
- backend and dashboard served from same runtime when possible

## Local API requirements
### Read
- `GET /health`
- `GET /api/status`
- `GET /api/accounts`
- `GET /api/usage`
- `GET /api/providers`
- `GET /api/model-groups`
- `GET /api/diagnostics`

### Write
- account enable/disable/delete where supported
- provider settings updates
- model-group updates
- server control actions if needed

## Design principles
- API thin over core services
- CLI and dashboard consume same contracts
- clear unsupported/unavailable states
- stable enough for future automation

## Acceptance criteria
- CLI can discover and talk to running backend
- Dashboard can use same local API
- State remains consistent after restart
