# PRD: Core Backend (`packages/core`)

## Purpose
`packages/core` is shared brain of VibeRelay. It must contain portable business logic with no frontend assumptions and minimal runtime coupling.

## Responsibilities
- Config loading and saving
- Local state directory management
- Account discovery/state management
- Provider registry and provider capability metadata
- Model-group definitions and routing
- Proxy lifecycle management
- Health/status aggregation
- Usage collection and normalization
- Diagnostics/log summaries
- Contracts used by CLI and dashboard

## Principles
- Node-compatible first
- Avoid Bun-only APIs in core
- Keep interfaces plain and serializable
- One source of truth for state
- Provider-specific behavior behind adapters

## Proposed modules
- `src/config/`
- `src/state/`
- `src/accounts/`
- `src/providers/`
- `src/model-groups/`
- `src/proxy/`
- `src/server/`
- `src/usage/`
- `src/diagnostics/`
- `src/contracts/`

## Functional requirements
1. Core can resolve portable app directories for config/state/runtime files.
2. Core can start, stop, and report health for local daemon/backend.
3. Core can expose normalized provider/account state regardless of backend differences.
4. Core can expose usage summaries per account when available.
5. Core can persist model groups and provider settings.
6. Core can expose stable contracts for CLI and dashboard.

## Data contracts needed
- Server status
- Account summary
- Provider summary
- Usage summary
- Model-group config
- Diagnostics summary

## Risks
- Provider differences will push complexity into normalization layer.
- Runtime/process management can leak platform-specific assumptions.
- Usage data may be unavailable or partial for some providers.

## Acceptance criteria
- Core can be imported without dashboard code.
- Core can power both CLI and HTTP handlers.
- Core types stay framework-agnostic.
