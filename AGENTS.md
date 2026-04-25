# AGENTS.md — orientation for AI agents working on viberelay

This file is for any agent (Claude, Codex, Cursor, whatever) that needs to make
correct changes to this repo. Read it before touching code. It's opinionated on
purpose — the rules below exist because we hit the failure mode at least once.

If you only read one thing: **the CLI talks to the daemon over HTTP; the daemon
talks to `cli-proxy-api` over HTTP; nothing else couples them.** Preserve
that boundary.

---

## Mental model

viberelay is three processes stacked:

```
claude / agents  →  viberelay-daemon (Node/Bun, :8327)  →  cli-proxy-api (Go, :8328)  →  upstream APIs
```

- **`viberelay` (CLI)** — thin client. All state it shows comes from daemon HTTP
  endpoints. The one thing it owns locally is `~/.viberelay/profiles/*.json`
  (Claude Code env bundles).
- **`viberelay-daemon` (daemon)** — owns the public surface: proxy endpoints,
  dashboard, model-group router, settings store, log buffer, account loader,
  provider-usage poller. Spawns `cli-proxy-api` as a managed child.
- **`cli-proxy-api`** — third-party Go binary (`router-for-me/CLIProxyAPI`).
  Owns upstream accounts, token refresh, round-robin. We ship the matching build
  as an asset (`resources/cli-proxy-api[.exe]`).

The daemon is the system of record for runtime state. The CLI never reads its
own settings from disk — it calls the daemon. Profiles are the only exception
because they're Claude-Code-side config, not viberelay state.

---

## Repo layout, with purpose

```
packages/
  shared/src/contracts.ts         Single source of truth for types shared
                                  between cli ↔ daemon. Keep payload shapes
                                  here, not duplicated in both packages.

  daemon/src/
    index.ts                      Entry. Wires everything; exports
                                  createDaemonController() used by tests.
                                  Contains the isCompiled / installRoot
                                  resolution — DO NOT refactor without
                                  understanding the /$bunfs/ constraint.
    runner.ts                     Bare launcher used by the compiled binary
                                  and `bunx tsx` dev mode.
    proxy/
      forwarding.ts               Request normalization + forward to the
                                  Go child. Owns usage recording.
      model-group-router.ts       Resolves a group alias (e.g. "opus-high")
                                  to a concrete upstream model, round-robin
                                  + failover.
      models-interceptor.ts       Rewrites /v1/models responses so clients
                                  see group aliases alongside real models.
      request-transformer.ts      Normalizes Anthropic / OpenAI / chat bodies
                                  before forwarding.
    dashboard/render.ts           Server-side HTML rendering for the dashboard
                                  (dynamic bits). Static JS/CSS live in
                                  resources/dashboard/.
    accounts/
      auth.ts                     Loads LocalAuthAccount records from
                                  ~/.cli-proxy-api/*.json, classifies them.
      manage.ts                   OAuth login launcher + API-key save flow.
    state/
      defaults.ts                 DEFAULT_MODEL_GROUPS, DEFAULT_PROVIDER_ENABLED,
                                  REMOVED_PROVIDERS, LOCKED_MODEL_GROUP_NAMES.
                                  Locked names are ones the UI must not let
                                  users rename/delete.
      settings-store.ts           JSON on disk at <stateDir>/settings.json.
                                  Single writer, debounced.
    runtime/
      log-buffer.ts               Capped in-memory ring buffer the dashboard
                                  polls. Do NOT replace with an unbounded log.
      time.ts                     ISO helpers.
    usage/provider-usage.ts       Background poller for 5h / weekly quota
                                  windows per account.
    backend/config-composer.ts    Generates the YAML config handed to the
                                  Go child on spawn.

  cli/src/
    bin.ts                        argv dispatch. Help text lives here.
    version.ts                    VERSION + UPSTREAM_REPO constants.
    lib/daemon-control.ts         PID-file lifecycle, SIGTERM→SIGKILL, spawn
                                  detached, ECONNREFUSED detection.
    commands/
      status.ts usage.ts          Read-only views of daemon state.
      accounts.ts                 Account listing from daemon.
      start.ts stop.ts            Daemon lifecycle via daemon-control.
      dashboard.ts                Open /dashboard in the user's browser.
      logs.ts                     Tail ~/.viberelay/state/daemon.log.
      service.ts                  launchd (macOS) / systemd --user (Linux)
                                  install/uninstall/status.
      profile.ts                  Interactive profile wizard + run.
      update.ts                   Self-update from GitHub releases.

resources/                        Shipped in the tarball. Anchor everything
                                  via installRoot (see index.ts).
  config.yaml                     Default cli-proxy-api config template.
  dashboard/                      Static UI assets.
  icons/                          Provider icons. Live here, not under
                                  packages/daemon/resources/.
  cli-proxy-api[.exe]        Upstream Go child, fetched by
                                  scripts/fetch-cliproxy.ts. .gitignored.

scripts/
  build.ts                        Bun --compile. --target for cross.
  package-release.ts              tar.gz / zip. Re-codesigns darwin bins.
  fetch-cliproxy.ts               Pulls the matching Go binary from
                                  router-for-me/CLIProxyAPI.

install.sh install.ps1            One-liner installers.
.github/workflows/
  release.yml                     Tag push viberelay-v* → stable release.
  nightly.yml                     main push → rolling viberelay-nightly.
```

---

## Runtime layout (installed)

```
~/.viberelay/
  bin/
    viberelay            # compiled Bun binary (CLI)
    viberelay-daemon     # compiled Bun binary (daemon)
  resources/
    config.yaml
    dashboard/
    icons/
    cli-proxy-api[.exe]
  state/
    daemon.pid           # PID of the running daemon
    daemon.log           # stdio of the daemon + Go child
    settings.json        # model groups, provider enable flags, etc.
  profiles/
    *.json               # Claude Code env bundles managed by the CLI

~/.cli-proxy-api/
  *.json                 # upstream account credentials (owned by the Go child)
```

Dev mode diverges: state → `./.state/`, resources → repo root. The switch is
the `isCompiled` check in `packages/daemon/src/index.ts` — Bun's `--compile`
serves modules from a read-only `/$bunfs/` path, so `import.meta.url` is useless
for resolving ship-next-to-binary resources. Anchor on `process.execPath`
instead.

---

## Invariants (break these and something will silently rot)

1. **CLI never reads daemon-owned state directly.** No reading `settings.json`,
   no grepping `daemon.log` for structured data. Go through HTTP.
2. **Daemon resources resolve via `installRoot`, never `import.meta.url`.**
   Compiled mode is read-only. If you add a new bundled asset, put it under
   top-level `resources/` and resolve with `resolve(installRoot, 'resources/...')`.
3. **`package-release.ts` ships top-level `resources/` only.** If you tuck
   assets under `packages/*/resources/`, they will not ship. (This bit us with
   the dashboard icons.)
4. **Bun-compiled macOS binaries must be re-codesigned after tar.** Tar strips
   the ad-hoc signature and the kernel sends `SIGKILL` (exit 137). The release
   pipeline and `install.sh` both re-sign; don't remove either.
5. **PID file is the single source of truth for "is the daemon running."**
   `daemon-control.ts` writes it on spawn, checks liveness with
   `process.kill(pid, 0)`, cleans it on stop. No port-scanning.
6. **Daemon commands degrade gracefully when offline.** Any CLI command that
   calls `fetch` against the daemon must catch `ECONNREFUSED` via
   `isConnectionRefused` and return a friendly string, not a stack trace.
7. **`LOCKED_MODEL_GROUP_NAMES` are UI-locked for a reason.** They're referenced
   by profile defaults and the dashboard dropdowns. Don't rename them without
   migrating profiles.
8. **Log buffer is capped.** It's a ring buffer by design — the dashboard polls
   it. Don't "fix" it to be unbounded; that's a memory leak.
9. **Tests bind to port 0.** Never hardcode 8327 in a test; you'll flake in CI.
10. **Never skip git hooks, never amend published commits.** Fix the failure;
    create a new commit.

---

## Common workflows

### Add a CLI command

1. `packages/cli/src/commands/<name>.ts` → export `run<Name>Command(options)`.
2. Re-export from `packages/cli/src/index.ts`.
3. Add the case branch in `packages/cli/src/bin.ts`; update `helpText()`.
4. Add a test in `packages/cli/test/`.
5. Document in `packages/cli/README.md`.

Return a string from the function. If you need live output (watch mode,
prompts), write to stdout directly and return `void` — match the shape of
`runUsageWatch` or `runProfileCommand`.

### Add a daemon endpoint

1. Handler goes under `packages/daemon/src/proxy/` or `dashboard/`.
2. Payload type → `packages/shared/src/contracts.ts`.
3. Wire the route in the router in `index.ts`.
4. Test with `createDaemonController({ port: 0 })` + a real HTTP round-trip.

### Change state schema

`state/settings-store.ts` is the only writer to `settings.json`. If you add a
field, give it a default in `state/defaults.ts` and handle missing-field
backwards-compat on read (don't migrate; just default). Users will have old
files on disk.

### Bump upstream Go child

1. Update the version pin in `scripts/fetch-cliproxy.ts`.
2. Verify the asset naming convention didn't change upstream.
3. Re-fetch locally and smoke-test a request.
4. Let nightly CI publish; verify the tarball actually contains the new binary
   before tagging a stable release.

---

## Running from source

See [CONTRIBUTING.md](CONTRIBUTING.md) — that doc is the source of truth for the
dev loop. TL;DR:

```bash
bun install
bunx tsx packages/daemon/src/runner.ts      # terminal 1
bunx tsx packages/cli/src/bin.ts status     # terminal 2
bunx vitest run                             # before every commit
bun run typecheck                           # zero errors, zero warnings
```

Dev state lives in `./.state/`. Delete it to reset.

---

## When you're about to make a change, ask yourself

- Does this couple the CLI to daemon internals? If yes, route it through HTTP
  instead.
- Does this read a resource using `import.meta.url`? If yes, break in compiled
  mode. Use `installRoot`.
- Does this add a top-level asset? Make sure `package-release.ts` copies it.
- Does this change a payload shape? Update `shared/contracts.ts` and check both
  consumers.
- Does this change state-file shape? Handle the old shape on read.
- Does this spawn a process? Use `daemon-control.ts` patterns (detached, unref,
  PID file, SIGTERM→SIGKILL with grace).
- Does this run on Windows? Check `.exe` suffixes, path separators, and the
  `install.ps1` path.
- Is there a test for it? There should be. Bind to port 0.

---

## What NOT to do

- **Don't** "clean up" the `isCompiled` branching. It looks ugly; it's correct.
- **Don't** add environment variables to paper over path bugs. Fix the path
  resolution at the source.
- **Don't** introduce a new config format. We have one: `settings.json`, written
  by `settings-store.ts`.
- **Don't** bypass `cli-proxy-api` and talk to upstream APIs directly from
  the daemon. Account state + token refresh lives in the Go child.
- **Don't** pin dependencies to `*` or `latest`. This ships to end-user
  machines; determinism matters.
- **Don't** print color to non-TTY stdout. Commands that render color (`usage`)
  must detect `process.stdout.isTTY` and gracefully downgrade.
- **Don't** use `rm -rf` anywhere — not in scripts, not in hooks, not in
  installers. Use `trash` or targeted deletes.

---

## If CI is red

1. Read the failing job log. Don't guess.
2. If it's the GitHub API rate limit on `fetch-cliproxy`, confirm `GITHUB_TOKEN`
   is wired into the job env.
3. If it's macOS SIGKILL on a smoke test, the re-sign step got dropped.
4. If it's Windows `zip: command not found`, `package-release.ts` lost the
   PowerShell `Compress-Archive` branch.
5. If it's the Intel macOS runner timing out, it's probably queue depth — the
   nightly matrix intentionally skips `macos-13`; the stable release keeps it.
6. Fix it in the same PR, not a follow-up. Red CI on `main` blocks everyone.

---

Questions that aren't covered here usually mean the code needs a comment, not
that this doc needs another section. Prefer small, surgical explanations at the
call site over growing this file into a book.
