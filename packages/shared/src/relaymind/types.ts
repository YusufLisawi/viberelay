/**
 * RelayMind shared contracts.
 *
 * Owned by the spine (this file is the load-bearing surface). Any change here
 * affects the memory layer, installer, supervisor, and Telegram dispatcher.
 * Do not modify casually.
 */

// ── Memory ───────────────────────────────────────────────────────────────────

export type MemoryItemType =
  | 'memory'
  | 'preference'
  | 'decision'
  | 'checkpoint'
  | 'daily_summary'
  | 'task'
  | 'idea'
  | 'bug'
  | 'open_loop'

export interface MemoryItem {
  id: number
  type: MemoryItemType
  title: string
  body: string
  source: string | null
  /** ISO date `YYYY-MM-DD`. */
  day: string
  importance: number
  /** ISO 8601 timestamp. */
  createdAt: string
  updatedAt: string
}

export type MemoryEdgeRel =
  | 'same_task'
  | 'followup'
  | 'depends_on'
  | 'mentioned_in'
  | 'decision_of'
  | 'supersedes'
  | 'caused_by'

export interface MemoryEdge {
  fromId: number
  toId: number
  rel: MemoryEdgeRel
  weight: number
  createdAt: string
}

export interface MemoryAddInput {
  type: MemoryItemType
  title: string
  body: string
  source?: string
  importance?: number
  /** Defaults to today (UTC). */
  day?: string
}

export interface MemorySearchOptions {
  query: string
  limit?: number
  /** Filter by item types. */
  types?: MemoryItemType[]
  /** Apply recency boost (default true). */
  recency?: boolean
  /** Expand top hits via one-hop edges (default false). */
  expandEdges?: boolean
}

export interface MemorySearchHit {
  item: MemoryItem
  /** FTS rank score (lower is better in raw FTS; layer presents as a normalized 0..1 where higher = more relevant). */
  score: number
  /** Edges traversed to reach this hit, if any. */
  via?: MemoryEdge[]
}

// ── Telegram command registry ────────────────────────────────────────────────

export type TelegramCommandMode = 'direct' | 'llm'
export type TelegramCommandRisk = 'read' | 'write' | 'external' | 'destructive'

export interface TelegramCommandManifestEntry {
  name: string
  description: string
  mode: TelegramCommandMode
  /** Direct handler module name (under commands/handlers/). Required when mode=direct. */
  handler?: string
  /** LLM prompt template. Required when mode=llm. */
  template?: string
  risk?: TelegramCommandRisk
  enabled?: boolean
  allowedChats?: string[]
  requiresApproval?: boolean
  reload?: 'manifest' | 'plugin-restart'
}

export interface TelegramCommandManifest {
  commands: TelegramCommandManifestEntry[]
}

export interface TelegramCommandContext {
  text: string
  args: string[]
  chatId: string
  userId?: string
  /** Path to RelayMind state dir. */
  stateDir: string
}

export interface TelegramCommandReply {
  /** What to do with this invocation. */
  action: 'reply' | 'forward-to-claude' | 'noop'
  /** Reply text when action=reply. */
  text?: string
  /** File attachments (absolute paths). */
  files?: string[]
  /** Prompt template to forward to Claude when action=forward-to-claude. */
  prompt?: string
}

export type DirectCommandHandler = (
  ctx: TelegramCommandContext,
) => Promise<TelegramCommandReply>

// ── Supervisor / lifecycle ───────────────────────────────────────────────────

export type SupervisorStatus = 'stopped' | 'starting' | 'running' | 'unhealthy' | 'rolling-back'

export interface SupervisorSessionMeta {
  /** Stable Claude Code session name (e.g. `relaymind-main`). */
  sessionName: string
  /** Claude session id (set after first run). */
  claudeSessionId?: string
  pid: number
  startedAt: string
  /** Path to the transcript Claude is writing to, when known. */
  transcriptPath?: string
  status: SupervisorStatus
}

export interface SupervisorHealth {
  status: SupervisorStatus
  /** Last health check ISO timestamp. */
  checkedAt: string
  /** Human-readable detail; empty when healthy. */
  detail?: string
  /** Last failure reason if status=unhealthy/rolling-back. */
  lastFailure?: string
}

// ── Context render (hook injection) ──────────────────────────────────────────

export type ContextEvent =
  | 'session-start'
  | 'user-prompt'
  | 'pre-compact'
  | 'stop'

export interface ContextRenderInput {
  event: ContextEvent
  /** Hook input fields per docs/relaymind/DECISIONS.md §D3. */
  sessionId?: string
  transcriptPath?: string
  cwd?: string
  prompt?: string
}

export type ContextPressure = 'low' | 'medium' | 'high' | 'critical'

export interface ContextRenderOutput {
  /** Markdown to inject. */
  text: string
  contextEstimate: ContextPressure
  recommendation: 'continue' | 'checkpoint-soon' | 'checkpoint-now' | 'avoid-large-reads'
  /** Memory hits referenced in the rendered text. */
  hitIds?: number[]
}

// ── RelayMind config ─────────────────────────────────────────────────────────

/**
 * Viberelay profile binding for the supervisor — when set, the supervisor
 * launches via `viberelay run <name>` instead of bare `claude`, so requests
 * route through the multi-account proxy and respect the configured model
 * groups. All fields are optional; absent values fall back to installer
 * defaults (`relaymind` / `high` / `mid` / `low`).
 */
export interface ViberelayProfileBinding {
  /** Profile name to create + run (defaults to `relaymind`). */
  name?: string
  /** Model group alias for opus (defaults to `high`). */
  opus?: string
  /** Model group alias for sonnet (defaults to `mid`). */
  sonnet?: string
  /** Model group alias for haiku (defaults to `low`). */
  haiku?: string
}

/**
 * How RelayMind launches the persistent Claude session:
 *
 * - `isolated` — Goes through `viberelay run -d <profile>`, redirects
 *   `CLAUDE_CONFIG_DIR` to a profile-local dir. Max isolation: user's plugins,
 *   CLAUDE.md, and credentials don't leak in. BUT: claude runs with API-key
 *   auth (`viberelay-local`) → Anthropic's `tengu_harbor` channels gate
 *   blocks `--channels` (auth check, see issue #36503). Inbound Telegram
 *   messages must go through `relaymind bridge`.
 *
 * - `passthrough` — Spawns `claude` directly with the user's `~/.claude/`
 *   config and credentials (OAuth). Channels work natively because OAuth
 *   passes the gate. Trade-off: user's existing plugins / CLAUDE.md / hooks
 *   load alongside RelayMind's. No viberelay proxy = no multi-account
 *   routing. Use this when channels matter more than isolation.
 */
export type RelayMindLaunchMode = 'isolated' | 'passthrough'

export interface RelayMindConfig {
  /** Stable Claude Code session name. */
  sessionName: string
  /** Local time HH:MM for daily summary, default '22:00'. */
  dailySummaryAt?: string
  /** Telegram bot token reference (do NOT inline secrets here — point to env or a secrets file). */
  telegramTokenEnv?: string
  /** Allowed Telegram chat ids. */
  allowedChats?: string[]
  /** Supervisor health check interval ms. */
  healthCheckIntervalMs?: number
  /** Viberelay profile binding (the supervisor launches `viberelay run <name>`). */
  viberelayProfile?: ViberelayProfileBinding
  /** Launch mode (default 'isolated'). See `RelayMindLaunchMode` for trade-offs. */
  launchMode?: RelayMindLaunchMode
}
