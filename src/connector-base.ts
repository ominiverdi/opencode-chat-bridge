/**
 * Base classes and utilities for chat connectors
 * 
 * Provides standardized session management, rate limiting, and command handling
 * that all connectors inherit from.
 */

import { ACPClient } from "./acp-client"
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
  sessionRetentionDays: number // 7
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
   */
  static formatHelpMessage(trigger: string, botName: string): string {
    return (
      `${botName} - OpenCode Chat Bridge\n\n` +
      `Commands:\n` +
      `- /status - Show session info\n` +
      `- /clear or /reset - Clear session history\n` +
      `- /help - Show this help\n\n` +
      `Usage: ${trigger} <your question>`
    )
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

/**
 * Abstract base class for all chat connectors
 * 
 * Provides:
 * - Session management (create, track, cleanup)
 * - Rate limiting
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
  
  constructor(config: ConnectorConfig) {
    this.sessionManager = new SessionManager<TSession>()
    this.rateLimiter = new RateLimiter()
    this.config = config
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
   * Cleanup old session directories on startup
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
    for (const [id, session] of this.sessionManager.sessions) {
      try {
        await session.client.disconnect()
        this.log(`Disconnected session: ${id}`)
      } catch (err) {
        this.logError(`Failed to disconnect session ${id}:`, err)
      }
    }
    this.sessionManager.clear()
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
   * @returns true if command was handled
   */
  protected async handleCommand(
    id: string,
    command: string,
    sendFn: (text: string) => Promise<void>
  ): Promise<boolean> {
    const cmd = command.toLowerCase().trim()
    
    if (cmd === "/status") {
      return await this.handleStatusCommand(id, sendFn)
    }
    
    if (cmd === "/clear" || cmd === "/reset") {
      return await this.handleClearCommand(id, sendFn)
    }
    
    if (cmd === "/help") {
      return await this.handleHelpCommand(sendFn)
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
    sendFn: (text: string) => Promise<void>
  ): Promise<boolean> {
    const message = CommandHandler.formatHelpMessage(
      this.config.trigger,
      this.config.botName
    )
    await sendFn(message)
    return true
  }
}
