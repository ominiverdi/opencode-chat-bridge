/**
 * Base interfaces for chat protocol adapters.
 * 
 * Each protocol (Matrix, Discord, IRC, etc.) implements ChatProtocol
 * to provide a unified interface for the bridge.
 */

export interface ChatMessage {
  /** Unique identifier for the room/channel */
  roomId: string
  /** Unique identifier for the sender */
  senderId: string
  /** Display name of the sender (if available) */
  senderName?: string
  /** Message content (plain text) */
  content: string
  /** Original message ID (for replies, reactions) */
  messageId?: string
  /** Timestamp in milliseconds */
  timestamp: number
  /** Whether this is a direct message */
  isDirect?: boolean
  /** Attachments (images, files) */
  attachments?: Attachment[]
  /** If this is a reply, the original message ID */
  replyTo?: string
}

export interface Attachment {
  /** MIME type */
  mimeType: string
  /** URL or data URI */
  url: string
  /** Filename if available */
  filename?: string
  /** Size in bytes */
  size?: number
}

export interface SendOptions {
  /** Format as HTML/markdown */
  format?: 'plain' | 'markdown' | 'html'
  /** Message to reply to */
  replyTo?: string
  /** Thread ID for threaded conversations */
  threadId?: string
}

export interface ChatProtocol {
  /** Protocol name (matrix, discord, irc) */
  readonly name: string
  
  /** Current connection state */
  readonly connected: boolean

  // Lifecycle
  
  /** Connect to the chat service */
  connect(): Promise<void>
  
  /** Disconnect gracefully */
  disconnect(): Promise<void>

  // Event handlers
  
  /** Register handler for incoming messages */
  onMessage(handler: (msg: ChatMessage) => void): void
  
  /** Register handler for connection state changes */
  onConnectionChange?(handler: (connected: boolean) => void): void

  // Actions
  
  /** Send a message to a room */
  sendMessage(roomId: string, content: string, options?: SendOptions): Promise<string>
  
  /** Send typing indicator */
  sendTyping(roomId: string, typing: boolean): Promise<void>
  
  /** Send a reaction/emoji */
  sendReaction?(roomId: string, messageId: string, emoji: string): Promise<void>
  
  /** Edit a previously sent message */
  editMessage?(roomId: string, messageId: string, newContent: string): Promise<void>

  // Room management
  
  /** Get list of joined rooms */
  getJoinedRooms(): Promise<string[]>
  
  /** Get room display name */
  getRoomName?(roomId: string): Promise<string | undefined>
}

/**
 * Configuration shared across all protocols
 */
export interface ProtocolConfig {
  /** Whether this protocol is enabled */
  enabled: boolean
  /** Patterns that trigger the bot (e.g., "@botname:", "!oc ") */
  triggerPatterns?: string[]
  /** Mode mappings (e.g., "!s" -> "serious") */
  modes?: Record<string, string>
  /** Rooms/channels to ignore */
  ignoreRooms?: string[]
  /** Users to ignore */
  ignoreUsers?: string[]
}
