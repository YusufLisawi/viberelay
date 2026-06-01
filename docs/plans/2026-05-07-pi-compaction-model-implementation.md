# Pi Compaction Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a globally configured compaction model and global compaction-only 1M toggle to the Pi viberelay extension.

**Architecture:** Extend the existing Pi extension in `~/.pi/agent/extensions/viberelay.ts` to manage a small global JSON config, register two slash commands for configuration, and intercept Pi compaction so summary generation uses the configured model instead of the session model. The compaction model can optionally be cloned with a 1M context window without affecting normal model selection.

**Tech Stack:** Pi extensions API, TypeScript, Node `fs`/`path`, Pi session compaction hooks.

---

### Task 1: Inspect compaction hook API and example code

**Files:**
- Read: `/Users/yusufisawi/.nvm/versions/node/v22.21.1/lib/node_modules/@mariozechner/pi-coding-agent/docs/compaction.md`
- Read: `/Users/yusufisawi/.nvm/versions/node/v22.21.1/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/custom-compaction.ts`

**Step 1: Read compaction hook docs**

Read the `session_before_compact` section in `docs/compaction.md` and note the exact return shape required to override compaction model/behavior.

**Step 2: Read example extension**

Inspect `examples/extensions/custom-compaction.ts` and copy the exact pattern Pi expects for custom compaction.

**Step 3: Record the exact API shape**

Write down the exact fields needed for the override result so implementation stays minimal and correct.

**Step 4: Commit notes if working in a repo branch**

```bash
git add docs/plans/2026-05-07-pi-compaction-model-design.md docs/plans/2026-05-07-pi-compaction-model-implementation.md
git commit -m "docs: add pi compaction model design and plan"
```

### Task 2: Add global config load/save helpers

**Files:**
- Modify: `~/.pi/agent/extensions/viberelay.ts`

**Step 1: Define config type**

Add a small TypeScript interface like:

```ts
interface CompactionModelConfig {
  provider?: string;
  modelId?: string;
  force1m: boolean;
}
```

**Step 2: Add config path helper**

Use Node `fs`/`path` and store config under a stable file such as:

```ts
~/.pi/agent/viberelay-compaction.json
```

**Step 3: Add `loadCompactionConfig()`**

Implement a safe reader that returns defaults when the file is missing or malformed.

**Step 4: Add `saveCompactionConfig()`**

Implement a small JSON writer.

**Step 5: Run a quick syntax check by loading models**

Run:

```bash
pi --list-models >/tmp/pi_models.txt
```

Expected: command succeeds and outputs the model table.

### Task 3: Register global config commands

**Files:**
- Modify: `~/.pi/agent/extensions/viberelay.ts`

**Step 1: Add `/compact-model`**

Behavior:
- no args: show current configured compaction model and 1M state
- with `provider/model`: save model globally

**Step 2: Validate lookup through registry**

Use:

```ts
ctx.modelRegistry.find(provider, modelId)
```

If missing, notify user and do not save.

**Step 3: Add `/compact-1m`**

Behavior:
- toggles global `force1m`
- persists to config file
- shows resulting state

**Step 4: Keep commands small and explicit**

Do not add selector UI yet. Keep it CLI-style.

**Step 5: Reload and smoke-test command registration**

Open Pi and verify `/compact-model` and `/compact-1m` appear in slash command completion.

### Task 4: Override compaction model during compaction

**Files:**
- Modify: `~/.pi/agent/extensions/viberelay.ts`
- Reference: `docs/compaction.md`, `examples/extensions/custom-compaction.ts`

**Step 1: Load global config during extension startup**

Initialize in-memory config from disk when the extension loads.

**Step 2: Add `session_before_compact` hook**

In the hook:
- if no model is configured, return nothing
- otherwise resolve configured model from registry

**Step 3: Apply optional 1M override**

Use:

```ts
const effectiveModel = force1m ? withContextWindow(model, 1_000_000) : model;
```

**Step 4: Return the exact compaction override structure**

Use the exact documented API shape from Pi docs/example so Pi compaction runs with that model only.

**Step 5: Fallback safely**

If model lookup/auth fails, notify and return nothing so normal compaction continues.

### Task 5: Verify behavior manually

**Files:**
- Modify: `~/.pi/agent/extensions/viberelay.ts` if fixes are needed

**Step 1: Verify extension still loads**

Run:

```bash
pi --list-models >/tmp/pi_models.txt
```

Expected: success.

**Step 2: Set a compaction model**

Inside Pi:

```text
/compact-model viberelay/gpt-5.4-mini
```

Expected: success notification.

**Step 3: Toggle compaction 1M**

Inside Pi:

```text
/compact-1m
```

Expected: success notification showing ON.

**Step 4: Trigger compaction manually**

Inside Pi:

```text
/compact
```

Expected: compaction completes using configured compaction model, while current chat model stays unchanged.

**Step 5: Toggle compaction 1M off and retest**

Expected: compaction still uses configured model but without forced 1M context.

### Task 6: Final cleanup and commit

**Files:**
- Modify: `~/.pi/agent/extensions/viberelay.ts`
- Keep: `docs/plans/2026-05-07-pi-compaction-model-design.md`
- Keep: `docs/plans/2026-05-07-pi-compaction-model-implementation.md`

**Step 1: Re-read extension file**

Check for dead code, duplicated helpers, and confusing notifications.

**Step 2: Verify no regression to `/1m`**

Inside Pi, toggle `/1m` on and off and ensure it still works for session-only model changes.

**Step 3: Commit**

```bash
git add ~/.pi/agent/extensions/viberelay.ts docs/plans/2026-05-07-pi-compaction-model-design.md docs/plans/2026-05-07-pi-compaction-model-implementation.md
git commit -m "feat: add configurable pi compaction model"
```
