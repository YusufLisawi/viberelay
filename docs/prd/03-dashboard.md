# PRD: Dashboard (`packages/dashboard`)

## Purpose
Dashboard is optional local control UI served by VibeRelay backend. It should expose main controls and visibility without adding heavy frontend overhead.

## Approach
- Server-rendered HTML
- Minimal CSS
- Minimal vanilla JS for polling and actions
- No React for v1

## Main sections
- Server controls
- Accounts
- Usage
- Providers
- Model groups
- Diagnostics

## Functional requirements
1. Dashboard loads from local backend with no separate frontend build dependency on user machine.
2. Dashboard shows live backend status.
3. Dashboard shows account/provider/model-group state from same contracts used by CLI.
4. Dashboard can trigger supported account/provider/model-group mutations.
5. Dashboard can show usage summaries and clearly indicate unavailable data.

## Polling model
- Status: fast polling
- Usage: moderate polling
- Diagnostics: moderate polling

## Why not SPA in v1
- Lower memory use
- Smaller install/runtime complexity
- Easier packaging
- Faster initial delivery

## Acceptance criteria
- Dashboard works after `viberelay start`
- Dashboard reflects same state as CLI
- No duplicate business logic in frontend
