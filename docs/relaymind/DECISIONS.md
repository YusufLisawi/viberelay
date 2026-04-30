# RelayMind Architecture Decisions

These resolve the open questions in PRD.md §949 before implementation. Update this doc when a decision changes — do not silently diverge.

## D1 — Package name and binary surface (PRD Q3)

**Decision:** One source tree, two bin entries. `viberelay relaymind <subcommand>` and `relaymind <subcommand>` are aliases of each other; both ship as built standalone binaries from `scripts/build.ts`.

**Reasons:**
- Standalone `relaymind` is the friendlier UX after setup — users who only want the assistant don't need to learn the proxy CLI.
- A shared module graph (the `runRelaymindCommand` registrar) keeps the two entry points in lockstep — no version drift.
- The repo's existing update/install/service machinery is reused (the binaries ship together; install scripts symlink both onto PATH).

**Consequence:** Skills, hooks, and TOOLS.md may use either form. The plugin bundle and SKILL.md files use `viberelay relaymind ...` for the longest-lived workspace path. Docs/README that target end users should prefer the bare `relaymind ...` form.

## D2 — Isolated Claude Code profile (PRD Q6)

**Decision:** Emulate isolation, do not require Claude Code native profile support.

The supervisor launches `claude` with:
- `cwd` set to `.relaymind/claude-home/`
- env `CLAUDE_PROJECT_DIR=<absolute path to .relaymind/claude-home>` (Claude Code already honors `CLAUDE_PROJECT_DIR` for hooks; we extend the convention)
- env `VIBERELAY_RELAYMIND_PROFILE=1` so hooks/skills can branch on context
- env `HOME` left untouched (do not hijack the user's `~/.claude/`)
- `--settings <profile>/settings.json` if/when Claude Code accepts it; otherwise rely on cwd-based project settings (`.claude/settings.json` inside the profile dir)

**Reasons:**
- Claude Code does not currently expose a documented `--profile` flag. Waiting for one blocks MVP.
- A dedicated cwd + project-local `.claude/settings.json` is already a supported isolation boundary.
- Leaves the user's global `~/.claude/` untouched per PRD §153.

**Consequence:** The "isolated profile" is a directory, not a Claude Code primitive. Installer (Agent B) creates `.relaymind/claude-home/.claude/{settings.json,skills,hooks,plugins}/` and `.relaymind/claude-home/{SOUL,MEMORY,TOOLS,CLAUDE}.md`. The supervisor (Agent C) sets cwd + env when spawning.

## D3 — Hook payload fields (PRD Q5)

**Decision:** Rely only on documented Claude Code hook input fields. The supervisor and `viberelay relaymind context render` accept hook input as JSON on stdin and read only:

- `session_id: string`
- `transcript_path: string` (absolute path)
- `cwd: string`
- `hook_event_name: string`
- `prompt: string` (UserPromptSubmit only; may be absent)

Any other field (model id, message counts, compaction state) is treated as best-effort and never required for correctness.

**Reasons:**
- These fields are documented and stable across Claude Code releases.
- Anything else risks silent breakage on Claude Code updates.

**Consequence:** Context-pressure estimation (PRD §809) is derived from `transcript_path` file size + checkpoint age — no reliance on undocumented fields.

## D4 — Command reload model (PRD Q1)

**Decision:** Two-tier reload.

- **Manifest changes** (`registry.json` edits, new entries, enabled toggles): hot-reload. The plugin re-reads `registry.json` on every Telegram slash command — no plugin restart needed.
- **Direct handler code changes** (TS files under `commands/handlers/`): require plugin process restart. The plugin caches handler modules in-process for performance and safety.
- **Transport / access / pairing changes** (server.ts, access.json schema): require full supervisor restart with rollback protection.

**Reasons:**
- Manifest reload is cheap and the common case Claude will exercise when self-editing.
- Handler hot-reload via dynamic import + cache-busting is fragile (esm import cache, partial-state corruption) and not worth the complexity for MVP.

**Consequence:** `viberelay relaymind telegram commands reload` triggers a manifest-only reload signal. Handler edits must invoke `viberelay relaymind restart --plugin-only` (Wave-2 supervisor).

---

## Open items deferred past MVP

- **Compaction trigger API:** Not exposed by Claude Code. RelayMind uses checkpoint-before-risk strategy (PRD §819) and assumes automatic compaction.
- **Daily summary scheduling time vs idle (PRD Q4):** Default to fixed local time `22:00` user-local. Make configurable in `.relaymind/config.json` later.
- **Standalone `relaymind` binary (PRD Q3 alt):** Reconsider after MVP if users request it.
