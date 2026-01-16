/**
 * Session Manager - Maps chat rooms to OpenCode sessions.
 * 
 * Maintains bidirectional mapping between chat rooms/channels
 * and OpenCode sessions, with persistence support.
 */

export interface SessionMapping {
  /** Chat room/channel ID */
  roomId: string
  /** OpenCode session ID */
  sessionId: string
  /** Protocol name (matrix, discord, etc.) */
  protocol: string
  /** When the mapping was created */
  createdAt: number
  /** Last activity timestamp */
  lastActivity: number
  /** Optional title/name for the session */
  title?: string
}

export interface SessionManagerConfig {
  /** Path to persist session mappings (optional) */
  persistPath?: string
  /** Max age in ms before session is considered stale (default: 7 days) */
  maxAge?: number
}

export class SessionManager {
  private mappings = new Map<string, SessionMapping>()
  private config: SessionManagerConfig

  constructor(config: SessionManagerConfig = {}) {
    this.config = {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      ...config,
    }
  }

  /**
   * Get session ID for a room, if one exists
   */
  getSession(protocol: string, roomId: string): string | undefined {
    const key = this.makeKey(protocol, roomId)
    const mapping = this.mappings.get(key)
    
    if (mapping) {
      // Check if session is stale
      if (this.isStale(mapping)) {
        this.mappings.delete(key)
        return undefined
      }
      return mapping.sessionId
    }
    
    return undefined
  }

  /**
   * Register a new session mapping
   */
  setSession(
    protocol: string, 
    roomId: string, 
    sessionId: string,
    title?: string
  ): void {
    const key = this.makeKey(protocol, roomId)
    const now = Date.now()
    
    this.mappings.set(key, {
      roomId,
      sessionId,
      protocol,
      createdAt: now,
      lastActivity: now,
      title,
    })
    
    this.persist()
  }

  /**
   * Update last activity for a room
   */
  touch(protocol: string, roomId: string): void {
    const key = this.makeKey(protocol, roomId)
    const mapping = this.mappings.get(key)
    
    if (mapping) {
      mapping.lastActivity = Date.now()
      this.persist()
    }
  }

  /**
   * Remove a session mapping
   */
  removeSession(protocol: string, roomId: string): void {
    const key = this.makeKey(protocol, roomId)
    this.mappings.delete(key)
    this.persist()
  }

  /**
   * Get all mappings for a protocol
   */
  getMappingsForProtocol(protocol: string): SessionMapping[] {
    return Array.from(this.mappings.values())
      .filter(m => m.protocol === protocol && !this.isStale(m))
  }

  /**
   * Get all active mappings
   */
  getAllMappings(): SessionMapping[] {
    return Array.from(this.mappings.values())
      .filter(m => !this.isStale(m))
  }

  /**
   * Load mappings from persistence
   */
  async load(): Promise<void> {
    if (!this.config.persistPath) return

    try {
      const file = Bun.file(this.config.persistPath)
      if (await file.exists()) {
        const data = await file.json() as SessionMapping[]
        this.mappings.clear()
        for (const mapping of data) {
          if (!this.isStale(mapping)) {
            const key = this.makeKey(mapping.protocol, mapping.roomId)
            this.mappings.set(key, mapping)
          }
        }
        console.log(`[session-manager] Loaded ${this.mappings.size} session mappings`)
      }
    } catch (error) {
      console.error('[session-manager] Failed to load mappings:', error)
    }
  }

  /**
   * Clean up stale mappings
   */
  cleanup(): number {
    let removed = 0
    for (const [key, mapping] of this.mappings) {
      if (this.isStale(mapping)) {
        this.mappings.delete(key)
        removed++
      }
    }
    if (removed > 0) {
      this.persist()
      console.log(`[session-manager] Cleaned up ${removed} stale mappings`)
    }
    return removed
  }

  // Private methods

  private makeKey(protocol: string, roomId: string): string {
    return `${protocol}:${roomId}`
  }

  private isStale(mapping: SessionMapping): boolean {
    if (!this.config.maxAge) return false
    return Date.now() - mapping.lastActivity > this.config.maxAge
  }

  private persist(): void {
    if (!this.config.persistPath) return

    const data = Array.from(this.mappings.values())
    Bun.write(this.config.persistPath, JSON.stringify(data, null, 2))
      .catch(err => console.error('[session-manager] Failed to persist:', err))
  }
}
