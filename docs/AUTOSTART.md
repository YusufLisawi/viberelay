# Viberelay Autostart Guide

Run `viberelay run` (or the daemon) as a managed background service that
auto-starts on login, restarts on crash, and (on Linux) restarts when memory
exceeds a limit. Backed by **launchd** on macOS and **systemd --user** on Linux.

There are two independent units:

| Unit                | Command                                  | What it runs                                                  |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| **daemon**          | `viberelay service install`              | The proxy daemon (`viberelay-daemon`).                         |
| **run-`<profile>`** | `viberelay service install-run <profile>` | A supervised `viberelay run -d <profile>` Claude session.      |

You can install one, the other, or both.

---

## Prerequisites

- `viberelay` installed and on `PATH` (the binary the service unit invokes).
- Claude Code installed and logged in once on this machine, so
  `~/.claude/.credentials.json` exists. The isolated profile borrows the
  OAuth token from there via symlink.
- A profile has been initialized (`viberelay profile create <name>` or
  `relaymind setup`) if you intend to use `install-run`.
- Linux only: a Telegram bot token in the environment if your channels include
  Telegram (`TELEGRAM_BOT_TOKEN` or `VIBERELAY_RELAYMIND_TOKEN`).

---

## Quickstart — Ubuntu server

```bash
# 1. One-time: log in to Claude so creds exist
claude

# 2. Install the auto-restart unit for your run-profile
viberelay service install-run vibe \
  --resume relay \
  --channels plugin:telegram@telegram-official \
  --memory-max 4G

# 3. Survive reboots without an active login session
loginctl enable-linger $USER

# 4. Verify
viberelay service status-run vibe
journalctl --user -u viberelay-run-vibe.service -f
```

That's the whole setup. The first run uses the supervisor's pre-marked trust
in `~/.claude.json` plus `--dangerously-skip-permissions`, so subsequent
restarts are non-interactive.

---

## Quickstart — macOS

```bash
claude  # one-time login

viberelay service install-run vibe \
  --resume relay \
  --channels plugin:telegram@telegram-official

viberelay service status-run vibe
tail -f ~/.viberelay/state/run-vibe.log
```

`--memory-max` is accepted but ignored on macOS (launchd has no equivalent).

---

## Subcommand reference

```
viberelay service <install|uninstall|status>
    Manages viberelay-daemon (the proxy). Auto-starts on login.

viberelay service <install-run|uninstall-run|status-run> <profile>
    [--resume <id>] [--channels <spec>] [--memory-max <size>]
    Manages a supervised `viberelay run` session.
```

| Flag             | Maps to                          | Notes                                                         |
| ---------------- | -------------------------------- | ------------------------------------------------------------- |
| `--resume <id>`  | `viberelay run --resume <id>`    | Reuse a Claude session id (e.g. `relay`).                     |
| `--channels <s>` | `viberelay run --channels <s>`   | e.g. `plugin:telegram@telegram-official`.                     |
| `--memory-max`   | systemd `MemoryMax=`             | Default `4G`. systemd kills + restarts the unit if exceeded.   |

The unit name on Linux is `viberelay-run-<profile>.service`. The launchd
label on macOS is `com.viberelay.run.<profile>`.

---

## File locations

| Path                                                  | Purpose                              |
| ----------------------------------------------------- | ------------------------------------ |
| `~/.config/systemd/user/viberelay-run-<p>.service`    | systemd unit (Linux)                  |
| `~/Library/LaunchAgents/com.viberelay.run.<p>.plist`  | launchd plist (macOS)                 |
| `~/.viberelay/state/run-<profile>.log`                | stdout + stderr (Linux + macOS)       |
| `~/.viberelay/state/daemon.log`                       | daemon stdout (when daemon installed) |
| `~/.viberelay/profiles/<profile>/`                    | isolated Claude profile               |
| `~/.claude/.credentials.json`                         | source of OAuth (symlinked into profile) |

---

## What "auto-restart on bloat" means

On Linux, the unit is generated with:

```ini
[Service]
Restart=always
RestartSec=5
MemoryMax=4G
```

If RSS exceeds `MemoryMax`, systemd sends SIGTERM, then SIGKILL on timeout,
then re-execs after `RestartSec`. Combined with `Restart=always` this also
covers crashes, panics, and clean exits.

On macOS, launchd's `KeepAlive=true` covers crashes and clean exits but does
**not** enforce a memory ceiling. If you need that on macOS, layer a watchdog
on top — out of scope for this guide.

---

## Verifying first-run trust

The supervisor pre-marks the workspace as trusted in `~/.claude.json` and
injects `--dangerously-skip-permissions` on the profile path, so the
"dangerous" prompt should not block restarts. To confirm before walking away:

```bash
# Linux
systemctl --user restart viberelay-run-<profile>.service
journalctl --user -u viberelay-run-<profile>.service -n 50 --no-pager

# macOS
launchctl kickstart -k gui/$UID/com.viberelay.run.<profile>
tail -n 50 ~/.viberelay/state/run-<profile>.log
```

If the log shows the session reaching steady state without a TTY prompt,
you're done.

---

## Troubleshooting

| Symptom                                              | Fix                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `service install: <profile> is required`             | Pass the profile name as the first positional after `install-run`.  |
| Unit starts then exits immediately                   | Inspect `~/.viberelay/state/run-<profile>.log` — usually missing creds, missing profile, or Telegram token absent. |
| `claude` not on `PATH` inside the unit               | systemd --user inherits the login env on most distros. If not, set `Environment=PATH=…` in the unit or set `VIBERELAY_BINARY` to an absolute path before `install-run`. |
| Restart storms                                       | `systemctl --user reset-failed viberelay-run-<profile>.service`, then fix the underlying error in the log. |
| Service stops when you log out                       | `loginctl enable-linger $USER` (Linux only).                        |
| Memory limit too aggressive                          | Reinstall with a higher `--memory-max` (e.g. `8G`).                 |

---

## Releasing this feature (maintainers)

`viberelay service install-run` ships with the regular CLI. To cut a release:

```bash
bun run typecheck
bun test
bun run build:all          # produces packages/cli/dist binaries
bun run package            # bundles release artifacts
```

Smoke-test on each target OS before tagging:

```bash
# Linux
viberelay service install-run smoke --channels plugin:telegram@telegram-official
systemctl --user is-active viberelay-run-smoke.service
viberelay service uninstall-run smoke

# macOS
viberelay service install-run smoke --channels plugin:telegram@telegram-official
launchctl list | grep com.viberelay.run.smoke
viberelay service uninstall-run smoke
```

Tag and push:

```bash
git commit -m "feat(service): supervised run-profile auto-start"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

The release workflow at `.github/workflows/release.yml` builds and publishes
the artifacts.

---

## Uninstall everything

```bash
viberelay service uninstall-run <profile>   # one per installed profile
viberelay service uninstall                 # daemon, if installed
loginctl disable-linger $USER               # Linux only, if you set it
```
