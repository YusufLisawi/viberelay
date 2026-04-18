# VibeRelay PRD Overview

## Summary
VibeRelay is a cross-platform local relay and control plane for multi-provider AI access. It ships as an npm-installable CLI with an optional local dashboard. Users should be able to start and stop the local backend, inspect status and usage from terminal, open a dashboard when needed, and manage provider/accounts/model groups from one place.

## Why this exists
Current VibeProxy value is strong, but current app shape is too tied to native/macOS assumptions. VibeRelay should preserve core behavior while becoming portable, CLI-first, and usable on any machine.

## Product goals
- Cross-platform first
- CLI-first workflow
- Optional dashboard, not required
- One shared backend core
- Low idle RAM
- Small practical install footprint
- Clear provider/account visibility
- Model-group routing support

## Non-goals for v1
- Desktop-native wrapper
- Heavy SPA frontend
- Multi-user remote hosting platform
- Cloud sync
- Real-time collaboration
- Full plugin marketplace

## Target users
- Developers running local AI proxy/routing stacks
- Users with multiple provider accounts
- Users who prefer terminal over native desktop apps
- Users who want quick dashboard access without living in browser

## V1 scope
- New package-based architecture
- `viberelay` CLI
- Local daemon/backend
- Optional dashboard served by backend
- Usage summary in CLI
- Account/provider/model-group management
- Provider coverage for Claude, Codex/OpenAI, GitHub Copilot, custom providers, OpenCode Go, Z.ai, Ollama, OpenRouter, NVIDIA NIM

## Package direction
Use packages from start:
- `packages/core`
- `packages/cli`
- `packages/dashboard`

Dashboard may stay mostly templates/assets, but keep separation at package boundary.

## Success criteria
- User can install and run `viberelay start`
- User can inspect `viberelay status`, `viberelay usage`, `viberelay accounts`
- User can run `viberelay dashboard` and manage state locally
- Same backend powers both CLI and dashboard
- State/config persist consistently across platforms
