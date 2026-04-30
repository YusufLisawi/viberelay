---
name: relaymind-commands
description: Add, edit, validate, and reload Telegram slash commands in the RelayMind registry via viberelay relaymind telegram commands. Use when the user asks to add a slash command, edit an existing one, list what's available, or push a manifest reload. Manifest edits hot-reload; handler code edits need a plugin restart (see DECISIONS.md §D4).
when-to-use: |
  - User asks to add/edit/remove a Telegram slash command
  - User asks "what commands are wired up?"
  - You changed `commands/registry.json` and need to reload
  - You added a new direct handler under `commands/handlers/`
when-not-to-use: |
  - To configure Telegram access / pairing — that's the telegram access skill
  - To send Telegram messages — that's the telegram reply tool
  - As a place to invent new CLI flags. Stick to the documented surface.
allowed-tools:
  - Bash(viberelay relaymind telegram *)
  - Read
  - Write
  - Edit
---

# relaymind-commands

The Telegram command registry is editable JSON at
`.relaymind/claude-home/commands/registry.json`, with optional direct
handlers under `.relaymind/claude-home/commands/handlers/`.

A command entry has two modes:

- `direct` — invokes a handler module by `handler` name; bypasses the LLM.
- `llm` — sends a templated prompt (with `{{args}}`) to the persistent
  Claude session.

## List

```bash
viberelay relaymind telegram commands list
```

## Add / edit

Manifest-only flow (hot-reloaded — D4):

1. Read `commands/registry.json`.
2. Append or update the entry. Required fields: `name`, `description`,
   `mode`. `direct` mode also needs `handler`; `llm` mode also needs
   `template`.
3. Validate:
   ```bash
   viberelay relaymind telegram commands validate
   ```
4. Reload:
   ```bash
   viberelay relaymind telegram commands reload
   ```

If `add` is exposed by the CLI as a direct subcommand, prefer it over
hand-editing JSON:

```bash
viberelay relaymind telegram commands add
```

## Direct handler edits

Handler TypeScript modules under `commands/handlers/` are cached
in-process. After editing one, the manifest reload is **not** enough —
restart the plugin (see the self-heal skill):

```bash
viberelay relaymind plugin verify
viberelay relaymind restart --plugin-only
```

## Hard rules

- Never edit `access.json`, the allowlist, or pairing state from this skill
  — that lives in the telegram access skill and must be triggered by the
  user typing in their terminal, not by a channel message.
- Names must be unique and `^[a-z][a-z0-9_-]*$`.
- Validate before reloading. A broken `registry.json` will refuse to load.
