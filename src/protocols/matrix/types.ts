/**
 * Matrix-specific type definitions and configuration.
 */

import type { ProtocolConfig } from '../base'

export interface MatrixConfig extends ProtocolConfig {
  /** Matrix homeserver URL (e.g., "https://matrix.org") */
  homeserver: string
  /** Bot's user ID (e.g., "@bot:matrix.org") */
  userId: string
  /** Access token for authentication */
  accessToken: string
  /** Device ID for E2EE (optional but recommended) */
  deviceId?: string
  /** End-to-end encryption settings */
  encryption?: {
    /** Enable E2EE support */
    enabled: boolean
    /** Path to store crypto keys */
    storePath?: string
  }
  /** Auto-join rooms when invited */
  autoJoin?: boolean
  /** Sync filter settings */
  sync?: {
    /** Initial sync limit */
    initialSyncLimit?: number
    /** Sync timeout in milliseconds */
    timeout?: number
  }
}

/**
 * Matrix room state for tracking
 */
export interface MatrixRoomState {
  roomId: string
  name?: string
  isEncrypted: boolean
  isDirect: boolean
  lastActivity: number
}

/**
 * Validate Matrix configuration
 */
export function validateMatrixConfig(config: unknown): config is MatrixConfig {
  if (typeof config !== 'object' || config === null) return false
  const c = config as Record<string, unknown>
  
  return (
    typeof c.homeserver === 'string' &&
    typeof c.userId === 'string' &&
    typeof c.accessToken === 'string'
  )
}
