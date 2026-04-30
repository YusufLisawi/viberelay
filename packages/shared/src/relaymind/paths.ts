import path from 'node:path'

/**
 * Filesystem layout for a RelayMind installation rooted at `repoRoot`.
 *
 * This is the contract that the installer (Agent B), supervisor (Agent C),
 * and memory layer (Agent A) all read. Do not move paths without updating
 * docs/relaymind/DECISIONS.md.
 */
export interface RelayMindPaths {
  repoRoot: string
  /** `.relaymind/` — RelayMind state root. */
  stateRoot: string
  /** `.relaymind/claude-home/` — isolated Claude Code profile cwd. */
  claudeHome: string
  /** Project-local Claude Code settings dir inside the profile. */
  claudeProjectDir: string
  /** SQLite memory database. */
  memoryDb: string
  /** Daily summary markdown directory. */
  dailyDir: string
  /** Generated MEMORY.md snapshot (inside claudeHome). */
  memoryMd: string
  /** SOUL.md identity file. */
  soulMd: string
  /** TOOLS.md tools/CLI guide. */
  toolsMd: string
  /** Profile-controlled CLAUDE.md. */
  claudeMd: string
  /** Profile-owned command registry + handlers. */
  commandsDir: string
  registryJson: string
  handlersDir: string
  /** Supervisor runtime state (pid, last-known-good registry, session id). */
  supervisorStateDir: string
  pidFile: string
  sessionFile: string
  lastGoodRegistry: string
  /** RelayMind config (user-editable). */
  configJson: string
  /** Skills/hooks installed by RelayMind into the profile. */
  skillsDir: string
  hooksDir: string
  /**
   * Isolated Claude Code "global" config dir (`CLAUDE_CONFIG_DIR`). Without
   * this, Claude reads `~/.claude/settings.json`, `~/.claude.json`,
   * `~/.claude/plugins/`, and walks parents for CLAUDE.md — bleeding the
   * user's normal environment into the relaymind session. Pointing
   * `CLAUDE_CONFIG_DIR` at this dir gives Claude a fresh global root.
   */
  claudeConfigDir: string
  /** `<claudeConfigDir>/settings.json` — isolated marketplace + enabledPlugins. */
  claudeConfigSettings: string
  /**
   * Profile-isolated state for the Telegram plugin (TELEGRAM_STATE_DIR).
   * Without this, the plugin defaults to `~/.claude/channels/telegram/`
   * which is SHARED across every Claude Code workspace — pairings,
   * allowlist, and bot tokens leak between RelayMind and any other
   * Telegram-enabled session the user runs.
   */
  telegramStateDir: string
  /** `<telegramStateDir>/.env` — token + access mode for this bot only. */
  telegramEnvFile: string
}

/**
 * Locate the workspace root from any cwd — handles being invoked from
 * inside `.relaymind/` (e.g. user cd'd into `.relaymind/supervisor/` to
 * inspect logs, or a tmux pane was opened with that as cwd).
 *
 * Strategy: if cwd contains a `.relaymind/` segment, return the path
 * up to (but not including) that segment. Otherwise return cwd unchanged.
 * This prevents the doubled-path bug where `relayMindPaths('~/foo/.relaymind/supervisor')`
 * would compute `~/foo/.relaymind/supervisor/.relaymind/claude-home/`.
 */
export function resolveWorkspaceRoot(cwd: string): string {
  const segments = cwd.split(path.sep)
  const idx = segments.indexOf('.relaymind')
  if (idx < 0) return cwd
  // Re-join everything up to (but excluding) the `.relaymind` segment.
  // For an absolute path we preserve the leading separator via the empty
  // first segment that `split` leaves.
  return segments.slice(0, idx).join(path.sep) || path.sep
}

export function relayMindPaths(repoRoot: string): RelayMindPaths {
  const root = resolveWorkspaceRoot(repoRoot)
  const stateRoot = path.join(root, '.relaymind')
  const claudeHome = path.join(stateRoot, 'claude-home')
  const claudeProjectDir = path.join(claudeHome, '.claude')
  const supervisorStateDir = path.join(stateRoot, 'supervisor')
  const commandsDir = path.join(claudeHome, 'commands')
  const telegramStateDir = path.join(stateRoot, 'telegram')
  const claudeConfigDir = path.join(stateRoot, 'claude-config')
  return {
    repoRoot: root,
    stateRoot,
    claudeHome,
    claudeProjectDir,
    memoryDb: path.join(stateRoot, 'relaymind.db'),
    dailyDir: path.join(stateRoot, 'daily'),
    memoryMd: path.join(claudeHome, 'MEMORY.md'),
    soulMd: path.join(claudeHome, 'SOUL.md'),
    toolsMd: path.join(claudeHome, 'TOOLS.md'),
    claudeMd: path.join(claudeHome, 'CLAUDE.md'),
    commandsDir,
    registryJson: path.join(commandsDir, 'registry.json'),
    handlersDir: path.join(commandsDir, 'handlers'),
    supervisorStateDir,
    pidFile: path.join(supervisorStateDir, 'pid'),
    sessionFile: path.join(supervisorStateDir, 'session.json'),
    lastGoodRegistry: path.join(supervisorStateDir, 'registry.last-good.json'),
    configJson: path.join(stateRoot, 'config.json'),
    skillsDir: path.join(claudeProjectDir, 'skills'),
    hooksDir: path.join(claudeProjectDir, 'hooks'),
    claudeConfigDir,
    claudeConfigSettings: path.join(claudeConfigDir, 'settings.json'),
    telegramStateDir,
    telegramEnvFile: path.join(telegramStateDir, '.env'),
  }
}
