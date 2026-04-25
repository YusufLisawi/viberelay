# Contributing to viberelay

Thanks for wanting to hack on this. This doc covers the dev loop — how to run the
stack from source, how to test your changes, and how to ship them.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (runtime + compiler + test runner)
- Git, a POSIX shell (macOS / Linux) or PowerShell (Windows)
- `codesign` on macOS if you plan to run compiled binaries locally
- A GitHub token in `GITHUB_TOKEN` if you hit rate limits when fetching the upstream
  Go binary (`cli-proxy-api`)

Node is **not** required — everything runs on Bun. `bunx tsc` gives us the types.

## First-time setup

```bash
git clone git@github.com:YusufLisawi/viberelay.git
cd viberelay
bun install
bun run typecheck
bunx vitest run
```

If `typecheck` and tests both pass, you're ready.

## Repo tour

```
packages/
  cli/        # `viberelay` binary (commands, profile wizard, self-update)
  daemon/     # `viberelay-daemon` binary (HTTP server, dashboard, routing)
  shared/     # types + contracts shared between cli and daemon
resources/
  config.yaml              # default cli-proxy-api config
  dashboard/               # static assets served by the daemon
  icons/                   # provider icons (shipped in the tarball)
  cli-proxy-api(.exe) # upstream Go child, fetched by scripts/fetch-cliproxy.ts
scripts/
  build.ts             # Bun --compile for host or all cross-targets
  package-release.ts   # Bundles bin + resources into tar.gz / zip
  fetch-cliproxy.ts    # Pulls the matching upstream Go binary
install.sh / install.ps1
.github/workflows/
  release.yml    # tag push → stable release assets
  nightly.yml    # main push → rolling prerelease
```

See [AGENTS.md](AGENTS.md) for a deeper architectural read — module-by-module,
where state lives, how requests flow, and which invariants to preserve.

## Dev loop (run from source, no compile)

Two terminals — one for the daemon, one for the CLI.

```bash
# Terminal 1 — daemon, hot code, no binary
bunx tsx packages/daemon/src/runner.ts

# Terminal 2 — CLI hitting the dev daemon
bunx tsx packages/cli/src/bin.ts status
bunx tsx packages/cli/src/bin.ts usage
bunx tsx packages/cli/src/bin.ts profile create
```

In dev mode state lives in `./.state/` and resources resolve from the repo root.
In compiled mode state lives in `~/.viberelay/state/` and resources resolve from
`$PREFIX/resources/`. The switch is driven by a `/$bunfs/` check in
`packages/daemon/src/index.ts` — don't paper over that with env hacks.

### Talking to a real upstream

The daemon forwards to `cli-proxy-api`. In dev you need that binary present:

```bash
bun scripts/fetch-cliproxy.ts --target bun-darwin-arm64   # or your host target
```

The script writes the binary + `CLIPROXY_VERSION` into `resources/`. Both are
`.gitignore`d — they're fetched per-machine and per-CI-run, never committed.

### Dashboard

With the daemon running, open `http://127.0.0.1:8327/dashboard`. Static assets live
at `resources/dashboard/`; edits hot-reload on refresh (the daemon re-reads files
on each request).

## Testing

All tests live under `packages/*/test/` and run with Vitest.

```bash
bunx vitest run                      # one-shot
bunx vitest                          # watch mode
bunx vitest run packages/cli         # just the cli package
bunx vitest run -t "profile"         # name filter
```

- Tests that spawn a real daemon use `createDaemonController` from
  `packages/daemon/src/index.ts`. Bind to port `0` and read the assigned port —
  never hardcode `8327` in tests.
- Tests that exercise CLI lifecycle commands (`start`, `stop`, …) stub the daemon
  binary via `VIBERELAY_DAEMON_BINARY` and state dir via `VIBERELAY_STATE_DIR`.
  See `packages/cli/test/lifecycle-commands.test.ts` for the pattern.
- Tests should **not** hit the network. If a command needs `fetch`, point it at a
  local daemon or stub the fetch.
- Tests that render colored output (`usage`) should pass `color: false` so
  assertions match plain strings. ANSI codes in golden strings get ugly fast.

## Types & lint

```bash
bun run typecheck       # bunx tsc --noEmit -p tsconfig.base.json
```

Zero errors, zero warnings. No `any`. Fix it; don't `@ts-ignore` it. This is
enforced in CI.

## Compile + package locally

You rarely need this — dev tsx is faster — but it's how you reproduce a release
build.

```bash
bun run build                                  # host target → dist/host/
bun run build:all                              # all cross-targets → dist/<target>/
bun run package -- --target bun-darwin-arm64   # produces dist/viberelay-<target>.tar.gz
```

To swap the freshly built binary into your installed copy (e.g. to dog-food):

```bash
viberelay stop
cp dist/host/viberelay{,-daemon} ~/.viberelay/bin/
codesign --remove-signature ~/.viberelay/bin/viberelay ~/.viberelay/bin/viberelay-daemon
codesign --force --sign -   ~/.viberelay/bin/viberelay ~/.viberelay/bin/viberelay-daemon
viberelay start
```

macOS ad-hoc re-sign is mandatory — Bun's signature breaks on copy and the kernel
sends `SIGKILL` (exit 137) on launch. The installer and release pipeline both do
this automatically.

## Adding a CLI command

1. Create `packages/cli/src/commands/<name>.ts` — export a
   `run<Name>Command(options): Promise<string>` that returns the text to print.
   Throw plain `Error` for hard failures; return a friendly string for soft ones
   (daemon down, nothing to do).
2. Re-export from `packages/cli/src/index.ts`.
3. Wire a `case '<name>':` branch in `packages/cli/src/bin.ts` that parses argv
   and calls the function.
4. Update the `helpText()` block in `bin.ts`.
5. Add a test under `packages/cli/test/`.
6. Update `packages/cli/README.md` with the new surface.

For long-running / interactive commands (like `usage --watch` or
`profile create`) the command owns its own stdout — it writes directly instead of
returning a string. Match the shape of `runUsageWatch` or the `Prompter`
interface in `profile.ts`.

## Adding a daemon endpoint

1. Add the handler under `packages/daemon/src/proxy/` or `packages/daemon/src/dashboard/`.
2. If the payload shape is consumed by the CLI, put the type in
   `packages/shared/src/contracts.ts`.
3. Register the route in the daemon's router.
4. Write a test that spins up `createDaemonController({ port: 0 })` and asserts
   against a real HTTP round-trip.

Never couple the CLI directly to daemon internals — it must go through HTTP.

## Commit & PR conventions

- Small, reviewable commits. Imperative present tense (`"fix icon 404 after
  install"`, not `"fixed"` or `"fixes"`).
- **Never** add yourself as a co-author on automated commits.
- Run `bun run typecheck` and `bunx vitest run` before pushing.
- Include a short "why" in the PR description, not just "what" — the diff shows
  the what.

## Releases

Two channels, driven entirely by git:

- **Stable:** push a tag matching `viberelay-v*` (e.g. `viberelay-v0.2.0`). The
  `release.yml` workflow builds the matrix, fetches the upstream Go binary,
  packages archives, re-signs macOS bins, and attaches everything to a new
  GitHub release.
- **Nightly:** every push to `main` triggers `nightly.yml`, which stamps the
  version as `<base>-nightly.<YYYYMMDDHHMM>.<shortsha>` and force-pushes a
  rolling `viberelay-nightly` prerelease.

Users pull new builds with `viberelay update` (stable) or
`viberelay update --channel nightly`.

If you break the release pipeline, fix it in the same PR that introduced the
break. A red nightly is not "someone else's problem."

## Reporting bugs

Open an issue with:
- Host OS + arch
- `viberelay --version`
- Full stderr from the failing command
- Relevant lines from `~/.viberelay/state/daemon.log`

For security issues, email the maintainer directly rather than filing a public
issue.

## Code of conduct

Be kind, be specific, assume good faith. That's it.
