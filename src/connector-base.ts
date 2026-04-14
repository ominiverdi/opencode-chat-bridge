/**
 * Base classes and utilities for chat connectors
 * 
 * Provides standardized session management, rate limiting, event deduplication,
 * active query guarding, session expiry, and command handling
 * that all connectors inherit from.
 */

import fs from "fs"
import { ACPClient, type OpenCodeCommand } from "./acp-client"
import { 
  getSessionDir, 
  ensureSessionDir, 
  cleanupOldSessions, 
  estimateTokens,
  getSessionStorageInfo,
  copyOpenCodeConfig,
} from "./session-utils"

// =============================================================================
// Types
// =============================================================================

/**
 * Base session interface - all connector sessions extend this
 */
export interface BaseSession {
  client: ACPClient
  createdAt: Date
  messageCount: number
  lastActivity: Date
  inputChars: number
  outputChars: number
}

/**
 * Calculated session statistics for /status command
 */
export interface SessionStats {
  age: number           // minutes since creation
  lastActivity: number  // minutes since last activity
  inputTokens: number
  outputTokens: number
  totalTokens: number
  contextPercent: string
}

/**
 * Configuration for BaseConnector
 */
export interface ConnectorConfig {
  connector: string           // "slack", "matrix", "whatsapp"
  trigger: string             // "!oc"
  botName: string             // "OpenCode Bot"
  rateLimitSeconds: number    // 5
  sessionRetentionDays: number // 7 (startup cleanup)
  sessionRetentionMins?: number // 30 (runtime expiry, optional)
  allowedUsers?: string[]
}

export function parseCsvList(value?: string): string[] {
  if (!value) return []
  return value
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
}

// =============================================================================
// RateLimiter
// =============================================================================

/**
 * Rate limiter to prevent message spam
 * Tracks last message time per user
 */
export class RateLimiter {
  private lastMessages = new Map<string, number>()
  
  /**
   * Check if user is allowed to send a message
   * @returns true if allowed, false if rate limited
   */
  check(userId: string, limitSeconds: number): boolean {
    const now = Date.now()
    const last = this.lastMessages.get(userId) || 0
    if (now - last < limitSeconds * 1000) {
      return false
    }
    this.lastMessages.set(userId, now)
    return true
  }
  
  /**
   * Clear all rate limit tracking
   */
  clear(): void {
    this.lastMessages.clear()
  }
}

// =============================================================================
// EventDeduplicator
// =============================================================================

/**
 * Prevents duplicate event processing across all connectors.
 * Every chat platform can deliver duplicate events (Slack retries,
 * Matrix sync replays, Discord re-deliveries, Mattermost WebSocket replays).
 * 
 * Tracks recently seen event IDs with timestamps and auto-evicts
 * entries older than maxAgeMs (default 5 minutes).
 */
export class EventDeduplicator {
  private seen = new Map<string, number>()
  private maxAgeMs: number
  
  constructor(maxAgeMs: number = 5 * 60 * 1000) {
    this.maxAgeMs = maxAgeMs
  }
  
  /**
   * Check if an event ID has been seen recently.
   * @returns true if duplicate (already seen), false if new
   */
  isDuplicate(eventId: string): boolean {
    this.evictStale()
    if (this.seen.has(eventId)) return true
    this.seen.set(eventId, Date.now())
    return false
  }
  
  /**
   * Remove entries older than maxAgeMs
   */
  private evictStale(): void {
    const cutoff = Date.now() - this.maxAgeMs
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id)
    }
  }
  
  /**
   * Number of tracked events (for testing)
   */
  get size(): number {
    return this.seen.size
  }
  
  /**
   * Clear all tracking
   */
  clear(): void {
    this.seen.clear()
  }
}

// =============================================================================
// SessionManager
// =============================================================================

/**
 * Manages sessions for a connector
 * Provides CRUD operations and statistics tracking
 */
export class SessionManager<T extends BaseSession> {
  public sessions = new Map<string, T>()
  
  get(id: string): T | undefined {
    return this.sessions.get(id)
  }
  
  set(id: string, session: T): void {
    this.sessions.set(id, session)
  }
  
  delete(id: string): boolean {
    return this.sessions.delete(id)
  }
  
  has(id: string): boolean {
    return this.sessions.has(id)
  }
  
  clear(): void {
    this.sessions.clear()
  }
  
  /**
   * Update session statistics after a message exchange
   */
  trackMessage(id: string, inputChars: number, outputChars: number): void {
    const session = this.get(id)
    if (session) {
      session.messageCount++
      session.lastActivity = new Date()
      session.inputChars += inputChars
      session.outputChars += outputChars
    }
  }
  
  /**
   * Calculate session statistics for /status command
   */
  getStats(id: string): SessionStats | null {
    const session = this.get(id)
    if (!session) return null
    
    const age = Math.round((Date.now() - session.createdAt.getTime()) / 1000 / 60)
    const lastActivity = Math.round((Date.now() - session.lastActivity.getTime()) / 1000 / 60)
    const inputTokens = estimateTokens(session.inputChars)
    const outputTokens = estimateTokens(session.outputChars)
    const totalTokens = inputTokens + outputTokens
    // Claude context is ~200k tokens
    const contextPercent = ((totalTokens / 200000) * 100).toFixed(2)
    
    return {
      age,
      lastActivity,
      inputTokens,
      outputTokens,
      totalTokens,
      contextPercent,
    }
  }
}

// =============================================================================
// CommandHandler
// =============================================================================

/**
 * Formats standardized command responses
 */
export class CommandHandler {
  /**
   * Format /status response
   */
  static formatStatusMessage(messageCount: number, stats: SessionStats): string {
    return (
      `Session status:\n` +
      `- Messages: ${messageCount}\n` +
      `- Age: ${stats.age} min | Last active: ${stats.lastActivity} min ago\n` +
      `- Tokens (est): ~${stats.totalTokens.toLocaleString()} (${stats.contextPercent}% of 200k)\n` +
      `  Input: ~${stats.inputTokens.toLocaleString()} | Output: ~${stats.outputTokens.toLocaleString()}\n` +
      `Note: OpenCode auto-compacts when context fills`
    )
  }
  
  /**
   * Format /help response
   * @param trigger Bot trigger prefix (e.g., "!oc")
   * @param botName Bot display name
   * @param openCodeCommands Optional list of OpenCode-native commands
   */
  static formatHelpMessage(
    trigger: string, 
    botName: string, 
    openCodeCommands?: { name: string; description: string }[]
  ): string {
    let msg = `${botName} - OpenCode Chat Bridge\n\n`
    msg += `Bridge commands:\n`
    msg += `- /status - Show session info\n`
    msg += `- /clear or /reset - Clear session history\n`
    msg += `- /help - Show this help\n`
    
    if (openCodeCommands && openCodeCommands.length > 0) {
      msg += `\nOpenCode commands:\n`
      for (const cmd of openCodeCommands) {
        msg += `- /${cmd.name} - ${cmd.description}\n`
      }
    }
    
    msg += `\nUsage: ${trigger} <your question>`
    return msg
  }
  
  static formatNoSessionMessage(): string {
    return "No active session."
  }
  
  static formatSessionClearedMessage(): string {
    return "Session cleared. Next message will start a fresh session."
  }
  
  static formatUnknownCommandMessage(command: string): string {
    return `Unknown command: ${command}. Try /help`
  }
  
  static formatConnectionErrorMessage(): string {
    return "Sorry, I couldn't connect to the AI service."
  }
  
  static formatProcessingErrorMessage(): string {
    return "Sorry, something went wrong processing your request."
  }
}

// =============================================================================
// BaseConnector
// =============================================================================

/** Default session expiry sweep interval: 60 seconds */
const EXPIRY_SWEEP_INTERVAL_MS = 60_000

/**
 * Parse SESSION_RETENTION_MINS from environment.
 * Returns undefined if not set or invalid (connector uses no runtime expiry).
 */
function parseSessionRetentionMins(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.SESSION_RETENTION_MINS
  if (!raw) return undefined
  const mins = parseInt(raw, 10)
  if (Number.isFinite(mins) && mins > 0) return mins
  return undefined
}

/**
 * Abstract base class for all chat connectors
 * 
 * Provides:
 * - Session management (create, track, cleanup, runtime expiry)
 * - Rate limiting
 * - Event deduplication
 * - Active query guarding
 * - Command handling (/status, /clear, /help)
 * - Standardized logging
 * 
 * Subclasses implement:
 * - start() - Platform-specific initialization
 * - stop() - Platform-specific cleanup
 * - sendMessage() - Platform-specific message sending
 */
export abstract class BaseConnector<TSession extends BaseSession> {
  protected sessionManager: SessionManager<TSession>
  protected rateLimiter: RateLimiter
  protected config: ConnectorConfig
  private eventDeduplicator: EventDeduplicator
  /** Session IDs with an in-flight query -- never evict these */
  protected activeQueries = new Set<string>()
  private allowedUsers: Set<string> | null = null
  private expiryInterval: NodeJS.Timeout | null = null
  
  constructor(config: ConnectorConfig) {
    this.sessionManager = new SessionManager<TSession>()
    this.rateLimiter = new RateLimiter()
    this.config = config
    this.eventDeduplicator = new EventDeduplicator()
    
    // Apply SESSION_RETENTION_MINS from env if not set in config
    if (this.config.sessionRetentionMins === undefined) {
      this.config.sessionRetentionMins = parseSessionRetentionMins(process.env)
    }

    if (this.config.allowedUsers && this.config.allowedUsers.length > 0) {
      this.allowedUsers = new Set(this.config.allowedUsers)
    }
  }
  
  /**
   * Get connector name in uppercase for logging
   */
  protected get logPrefix(): string {
    return this.config.connector.toUpperCase()
  }
  
  // ---------------------------------------------------------------------------
  // Abstract methods - must be implemented by subclasses
  // ---------------------------------------------------------------------------
  
  abstract start(): Promise<void>
  abstract stop(): Promise<void>
  abstract sendMessage(id: string, text: string): Promise<void>
  
  // ---------------------------------------------------------------------------
  // Logging - Standardized format
  // ---------------------------------------------------------------------------
  
  protected log(message: string, ...args: any[]): void {
    console.log(`[${this.logPrefix}] ${message}`, ...args)
  }
  
  protected logError(message: string, ...args: any[]): void {
    console.error(`[${this.logPrefix}] ${message}`, ...args)
  }
  
  /**
   * Log startup information
   */
  protected logStartup(): void {
    const storageInfo = getSessionStorageInfo()
    this.log("Starting...")
    console.log(`  Trigger: ${this.config.trigger}`)
    console.log(`  Bot name: ${this.config.botName}`)
    console.log(`  Session storage: ${storageInfo.baseDir}`)
    console.log(`    (${storageInfo.source})`)
    if (this.allowedUsers) {
      console.log(`  Allowed users: ${Array.from(this.allowedUsers).join(", ")}`)
    }
    if (this.config.sessionRetentionMins) {
      console.log(`  Session expiry: ${this.config.sessionRetentionMins} min (inactivity)`)
    }
  }

  protected isUserAllowed(userId: string): boolean {
    if (!this.allowedUsers) return true
    const allowed = this.allowedUsers.has(userId)
    if (!allowed) {
      this.log(`[IGNORED] Message from non-allowed user: ${userId}`)
    }
    return allowed
  }
  
  // ---------------------------------------------------------------------------
  // Event Deduplication
  // ---------------------------------------------------------------------------
  
  /**
   * Check if an event has already been processed.
   * Call this before processing any incoming event.
   * The eventId format is platform-specific (e.g., Slack: "channel:ts").
   * @returns true if this event was already seen (skip it), false if new
   */
  protected isDuplicateEvent(eventId: string): boolean {
    const isDup = this.eventDeduplicator.isDuplicate(eventId)
    if (isDup) {
      this.log(`[DEDUP] Skipping duplicate event: ${eventId}`)
    }
    return isDup
  }
  
  // ---------------------------------------------------------------------------
  // Active Query Guard
  // ---------------------------------------------------------------------------
  
  /**
   * Check if a session has an in-flight query.
   */
  protected isQueryActive(sessionId: string): boolean {
    return this.activeQueries.has(sessionId)
  }
  
  /**
   * Mark a session as having an active query.
   * Call before starting prompt processing.
   */
  protected markQueryActive(sessionId: string): void {
    this.activeQueries.add(sessionId)
  }
  
  /**
   * Mark a session query as complete.
   * Call in the finally block after prompt processing.
   */
  protected markQueryDone(sessionId: string): void {
    this.activeQueries.delete(sessionId)
  }
  
  // ---------------------------------------------------------------------------
  // Session Management - Standardized
  // ---------------------------------------------------------------------------
  
  /**
   * Get or create a session for the given identifier
   * @param id - Channel/room/chat identifier
   * @param createSessionData - Function to create session-specific data
   */
  protected async getOrCreateSession(
    id: string,
    createSessionData: (client: ACPClient) => TSession
  ): Promise<TSession | null> {
    let session = this.sessionManager.get(id)
    
    if (!session) {
      const sessionDir = getSessionDir(this.config.connector, id)
      ensureSessionDir(sessionDir)
      copyOpenCodeConfig(sessionDir)  // Apply security permissions
      
      const client = new ACPClient({ cwd: sessionDir })
      
      try {
        await client.connect()
        await client.createSession()
        session = createSessionData(client)
        this.sessionManager.set(id, session)
        this.log(`Created session: ${id}`)
        console.log(`  Directory: ${sessionDir}`)
      } catch (err) {
        this.logError(`Failed to create session:`, err)
        return null
      }
    }
    
    return session
  }
  
  /**
   * Create a new session object with default values
   * Helper for subclasses to use with getOrCreateSession
   */
  protected createBaseSession(client: ACPClient): BaseSession {
    return {
      client,
      createdAt: new Date(),
      messageCount: 0,
      lastActivity: new Date(),
      inputChars: 0,
      outputChars: 0,
    }
  }
  
  /**
   * Cleanup old session directories on startup (days-based).
   * For runtime expiry (minutes-based), use startSessionExpiryLoop().
   */
  protected async cleanupSessions(): Promise<void> {
    this.log("Cleaning up old sessions...")
    const cleaned = cleanupOldSessions(
      this.config.connector,
      this.config.sessionRetentionDays
    )
    if (cleaned > 0) {
      console.log(`  Cleaned ${cleaned} session(s) older than ${this.config.sessionRetentionDays} days`)
    } else {
      console.log(`  No old sessions to clean`)
    }
  }
  
  /**
   * Disconnect all sessions on shutdown
   */
  protected async disconnectAllSessions(): Promise<void> {
    this.stopSessionExpiryLoop()
    for (const [id, session] of this.sessionManager.sessions) {
      try {
        await session.client.disconnect()
        this.log(`Disconnected session: ${id}`)
      } catch (err) {
        this.logError(`Failed to disconnect session ${id}:`, err)
      }
    }
    this.sessionManager.clear()
    this.activeQueries.clear()
  }
  
  // ---------------------------------------------------------------------------
  // Session Expiry - Runtime background sweep
  // ---------------------------------------------------------------------------
  
  /**
   * Start the background session expiry loop.
   * Call this from start() after the connector is ready.
   * Only runs if sessionRetentionMins is configured.
   */
  protected startSessionExpiryLoop(): void {
    if (this.expiryInterval) return
    if (!this.config.sessionRetentionMins) return
    
    this.expiryInterval = setInterval(() => {
      this.expireStaleSessions().catch((err) => {
        this.logError("[SESSION_EXPIRY] Sweep failed:", err)
      })
    }, EXPIRY_SWEEP_INTERVAL_MS)
  }
  
  /**
   * Stop the background session expiry loop.
   * Called automatically by disconnectAllSessions().
   */
  protected stopSessionExpiryLoop(): void {
    if (this.expiryInterval) {
      clearInterval(this.expiryInterval)
      this.expiryInterval = null
    }
  }
  
  /**
   * Expire sessions that have been inactive longer than sessionRetentionMins.
   * Sessions with active in-flight queries are never evicted.
   */
  private async expireStaleSessions(): Promise<void> {
    const retentionMins = this.config.sessionRetentionMins
    if (!retentionMins) return
    
    const now = Date.now()
    const staleIds: string[] = []
    
    for (const [id, session] of this.sessionManager.sessions) {
      if (this.activeQueries.has(id)) continue
      const inactiveMins = (now - session.lastActivity.getTime()) / 60_000
      if (inactiveMins >= retentionMins) staleIds.push(id)
    }
    
    for (const id of staleIds) {
      const session = this.sessionManager.get(id)
      if (session) {
        try {
          await session.client.disconnect()
        } catch {}
      }
      this.sessionManager.delete(id)
      this.deleteSessionCacheDir(id)
      this.log(`[SESSION_EXPIRY] ${id} expired after ${retentionMins}m inactivity`)
    }
  }
  
  /**
   * Delete the on-disk session cache directory for an expired session.
   */
  private deleteSessionCacheDir(id: string): void {
    const dir = getSessionDir(this.config.connector, id)
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch (err) {
      this.logError(`[SESSION_EXPIRY] Failed to clean cache for ${id}:`, err)
    }
  }
  
  // ---------------------------------------------------------------------------
  // Rate Limiting - Standardized
  // ---------------------------------------------------------------------------
  
  /**
   * Check if user is rate limited
   */
  protected checkRateLimit(userId: string): boolean {
    const allowed = this.rateLimiter.check(userId, this.config.rateLimitSeconds)
    if (!allowed) {
      this.log(`Rate limited: ${userId}`)
    }
    return allowed
  }
  
  // ---------------------------------------------------------------------------
  // Command Handling - Standardized
  // ---------------------------------------------------------------------------
  
  /**
   * Handle a command (starts with /)
   * @param id - Channel/room/chat identifier
   * @param command - The command string (e.g., "/status")
   * @param sendFn - Function to send response
   * @param options - Optional: OpenCode commands and forward callback
   * @returns true if command was handled, false if it should be forwarded to OpenCode
   */
  protected async handleCommand(
    id: string,
    command: string,
    sendFn: (text: string) => Promise<void>,
    options?: {
      openCodeCommands?: OpenCodeCommand[]
      forwardToOpenCode?: (command: string) => Promise<void>
    }
  ): Promise<boolean> {
    const cmd = command.toLowerCase().trim()
    const cmdName = cmd.replace(/^\//, "").split(" ")[0]  // Extract command name without /
    
    // Bridge-local commands
    if (cmd === "/status") {
      return await this.handleStatusCommand(id, sendFn)
    }
    
    if (cmd === "/clear" || cmd === "/reset") {
      return await this.handleClearCommand(id, sendFn)
    }
    
    if (cmd === "/help") {
      return await this.handleHelpCommand(sendFn, options?.openCodeCommands)
    }
    
    // Check if this is an OpenCode command
    const openCodeCommands = options?.openCodeCommands || []
    const isOpenCodeCmd = openCodeCommands.some(c => c.name === cmdName)
    
    if (isOpenCodeCmd && options?.forwardToOpenCode) {
      // Forward to OpenCode - return false to indicate caller should process as prompt
      await options.forwardToOpenCode(command)
      return true
    }
    
    await sendFn(CommandHandler.formatUnknownCommandMessage(command))
    return true
  }
  
  private async handleStatusCommand(
    id: string,
    sendFn: (text: string) => Promise<void>
  ): Promise<boolean> {
    const session = this.sessionManager.get(id)
    if (session) {
      const stats = this.sessionManager.getStats(id)!
      const message = CommandHandler.formatStatusMessage(session.messageCount, stats)
      await sendFn(message)
    } else {
      await sendFn(CommandHandler.formatNoSessionMessage())
    }
    return true
  }
  
  private async handleClearCommand(
    id: string,
    sendFn: (text: string) => Promise<void>
  ): Promise<boolean> {
    const session = this.sessionManager.get(id)
    if (session) {
      try {
        await session.client.disconnect()
      } catch {}
      this.sessionManager.delete(id)
      await sendFn(CommandHandler.formatSessionClearedMessage())
    } else {
      await sendFn(CommandHandler.formatNoSessionMessage())
    }
    return true
  }
  
  private async handleHelpCommand(
    sendFn: (text: string) => Promise<void>,
    openCodeCommands?: OpenCodeCommand[]
  ): Promise<boolean> {
    const message = CommandHandler.formatHelpMessage(
      this.config.trigger,
      this.config.botName,
      openCodeCommands
    )
    await sendFn(message)
    return true
  }
}
