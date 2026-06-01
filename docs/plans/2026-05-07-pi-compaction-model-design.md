# Pi Compaction Model Design

## Goal
Allow Pi to use a globally configured compaction model that is independent from the current session model, with a separate global toggle to force that compaction model to use a 1M context window.

## User requirements
- The compaction model is a global default, not per-session.
- The user chooses the compaction model explicitly.
- The user can toggle whether compaction should force 1M context for that model.
- The normal session model must remain unchanged.
- If the configured model is unavailable or unauthenticated, compaction should fall back gracefully.

## Recommended UX
- `/compact-model` with no args shows current compaction model.
- `/compact-model <provider/model>` sets the global compaction model.
- `/compact-1m` toggles the global compaction 1M override.
- Optional future enhancement: `/compact-config` interactive selector.

## Architecture
Store extension-managed global config in the Pi agent directory, separate from session state. On `session_before_compact`, the extension resolves the configured model from Pi's model registry. If `force1m` is enabled, it clones the model object with `contextWindow: 1_000_000`. It then instructs Pi to use that model for compaction generation only, without changing the session's active model.

## Data shape
```json
{
  "provider": "viberelay",
  "modelId": "gpt-5.4-mini",
  "force1m": true
}
```

## Safety and fallback behavior
- If no compaction model is configured, do nothing and let Pi compact normally.
- If the configured model cannot be found, show a warning and allow default compaction.
- If the configured model lacks auth, show a warning and allow default compaction.
- The 1M override applies only to compaction, not normal chat/model selection.

## Implementation notes
- Use `pi.registerCommand()` for `/compact-model` and `/compact-1m`.
- Use a small JSON file under `~/.pi/agent/` for persistence.
- Use `session_before_compact` to override compaction behavior.
- Reuse the same `withContextWindow()` helper used by `/1m`.
