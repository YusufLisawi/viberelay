# viberelay

Multi-provider Claude API proxy. Point `claude` at it, share one pool of Claude / Codex / Copilot / Ollama accounts across your agents, and get round-robin + automatic failover for free.

- **Proxy + daemon** — local HTTP server that speaks Anthropic, OpenAI, and OpenAI-chat APIs and forwards to a pool of upstream accounts managed by [`cli-proxy-api-plus`](https://github.com/router-for-me/CLIProxyAPIPlus).
- **Model groups** — alias tiers like `opus-high`, `sonnet-balanced`, `haiku-fast` that map to one or more real models; the router round-robins and fails over between them.
- **Profile system** — per-workspace JSON profiles that wire `claude` to the proxy with your chosen group aliases for opus/sonnet/haiku, optional clp-style account isolation.
- **CLI** — one binary, zero Node runtime required on the target machine; self-updates from GitHub releases.
- **Web dashboard** — provider toggles, account switches, 5h / weekly quota countdowns, group editor, live logs.

## Quick start

Install the CLI:

```bash
# macOS / Linux
curl -fsSL https://github.com/YusufLisawi/viberelay/releases/latest/download/install.sh | bash

# Windows (PowerShell)
irm https://github.com/YusufLisawi/viberelay/releases/latest/download/install.ps1 | iex
```

Run the daemon, create a profile, launch Claude Code through the proxy:

```bash
viberelay-daemon &                       # listens on 127.0.0.1:8327
viberelay profile create                 # interactive wizard: name + model group aliases
viberelay profile run --dangerous vibe   # spawns `claude` with that profile's env
```

Self-update:

```bash
viberelay update --check                 # latest stable
viberelay update --channel nightly       # rolling build from main
```

Everything else: **[packages/cli/README.md](packages/cli/README.md)** — full command reference, profile flags, release pipeline, HTTP endpoints.

## Architecture

```
┌──────────────┐    ┌──────────────────────┐    ┌────────────────────────┐
│  claude /    │    │  viberelay-daemon    │    │  cli-proxy-api-plus    │
│  agents      ├──► │  :8327 (Node/Bun)    ├───►│  :8328 (Go)            │
│  (your apps) │    │  • dashboard          │    │  • upstream pools      │
│              │    │  • model-group router │    │  • round-robin         │
│              │    │  • settings store     │    │  • token refresh       │
└──────────────┘    └──────────────────────┘    └─────────┬──────────────┘
                                                          │
                         ┌────────────────────────────────┼──────────────┐
                         ▼                                ▼              ▼
                 Claude OAuth accts            Codex / ChatGPT        Ollama, etc.
```

- `viberelay-daemon` owns the public HTTP surface, the dashboard, model-group routing, settings persistence.
- `cli-proxy-api-plus` (bundled from upstream) holds provider accounts, rotates tokens, and forwards to the real upstream APIs.
- `viberelay` (CLI) is a thin client over the daemon's HTTP endpoints + a local profile manager for Claude Code.

## Repo layout

```
packages/
  cli/       # `viberelay` binary — commands, profile wizard, self-update
  daemon/    # `viberelay-daemon` binary — HTTP server + dashboard
  shared/    # types shared between cli & daemon
resources/   # config.yaml, dashboard static, upstream cli-proxy-api-plus (fetched in CI)
scripts/
  build.ts             # Bun --compile cross-target
  package-release.ts   # tar.gz / zip per target with bins + resources
  fetch-cliproxy.ts    # pulls the matching upstream Go binary
install.sh / install.ps1   # one-liner installers
.github/workflows/
  release.yml    # tag push → stable release assets on GitHub
  nightly.yml    # main push → rolling `viberelay-nightly` release
```

## Develop

Requires [Bun](https://bun.sh).

```bash
bun install
bun run typecheck
bunx vitest run

# Run daemon + CLI straight from source
bunx tsx packages/daemon/src/runner.ts
bunx tsx packages/cli/src/bin.ts status
```

Fetch the upstream Go child once (per OS/arch you target), then compile:

```bash
bun scripts/fetch-cliproxy.ts --target bun-darwin-arm64
bun run build                         # host target
bun run build -- --target bun-linux-x64
bun run package -- --target bun-darwin-arm64
```

## Release

- **Stable:** `git tag viberelay-v0.2.0 && git push --tags` — triggers `release.yml`, publishes archives + installers to a new GitHub release. Users `viberelay update` picks it up.
- **Nightly:** every push to `main` triggers `nightly.yml`, which stamps `<version>-nightly.<ts>.<sha>` and force-pushes a rolling `viberelay-nightly` tag + prerelease. Users `viberelay update --channel nightly` picks it up.

## License

Private, all rights reserved for now.
