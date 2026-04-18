# VibeRelay PRDs

This directory splits VibeRelay product requirements into focused docs.

## Documents
- `00-overview.md` — product summary, goals, scope, package direction
- `01-core-backend.md` — shared backend/core package requirements
- `02-cli.md` — CLI command surface and UX requirements
- `03-dashboard.md` — optional local dashboard requirements
- `04-providers-and-accounts.md` — provider/account/model-group normalization
- `05-storage-runtime-and-api.md` — persistence, daemon model, local API
- `06-phased-delivery.md` — delivery phases and v1 definition of done

## Package direction
Start with:
- `packages/core`
- `packages/cli`
- `packages/dashboard`

All business logic should live in core. CLI and dashboard are control surfaces over same core/contracts.
