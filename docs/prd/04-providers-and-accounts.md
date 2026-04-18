# PRD: Providers and Accounts

## Purpose
VibeRelay must unify different providers and account sources behind one model while preserving provider-specific capabilities and limitations.

## V1 provider scope
- Claude
- Codex/OpenAI
- GitHub Copilot
- Custom providers
- OpenCode Go
- Z.ai
- Ollama
- OpenRouter
- NVIDIA NIM

## Core requirements
1. Each provider has clear capability metadata.
2. Accounts can be listed with provider association.
3. Enabled/disabled state is visible and mutable where supported.
4. Usage availability is explicit per provider/account.
5. Missing capabilities should show as unsupported, not silently absent.

## Provider model needs
- identity
- auth source/type
- enabled state
- account list
- usage availability
- routing eligibility
- settings/credentials presence

## Account model needs
- stable ID
- provider
- display label
- enabled/disabled state
- disable reason when available
- usage summary when available

## Model groups
V1 must support grouped routing such as high/mid/low or similar named groups. These groups should map to provider/model choices and be inspectable/editable from CLI and dashboard.

## Acceptance criteria
- Provider list is normalized
- Account summaries are stable
- Read-only providers are labeled clearly
- Model groups persist and reload correctly
