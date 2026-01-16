/**
 * Matrix protocol implementation using matrix-js-sdk.
 * 
 * Handles connection to Matrix homeserver, message events,
 * and optional end-to-end encryption.
 */

import type { ChatProtocol, ChatMessage, SendOptions, Attachment } from '../base'
import type { MatrixConfig, MatrixRoomState } from './types'

// matrix-js-sdk types (simplified for now)
interface MatrixClient {
  startClient(options?: { initialSyncLimit?: number }): Promise<void>
  stopClient(): void
  on(event: string, handler: (...args: unknown[]) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
  sendMessage(roomId: string, content: object): Promise<{ event_id: string }>
  sendTyping(roomId: string, typing: boolean, timeout?: number): Promise<void>
  getJoinedRooms(): Promise<{ joined_rooms: string[] }>
  getRoom(roomId: string): { name?: string } | null
  getUserId(): string | null
}

export class MatrixProtocol implements ChatProtocol {
  readonly name = 'matrix'
  
  private client: MatrixClient | null = null
  private messageHandler?: (msg: ChatMessage) => void
  private connectionHandler?: (connected: boolean) => void
  private _connected = false
  private rooms = new Map<string, MatrixRoomState>()

  constructor(private config: MatrixConfig) {}

  get connected(): boolean {
    return this._connected
  }

  async connect(): Promise<void> {
    // Dynamic import to avoid issues if matrix-js-sdk not installed
    const sdk = await import('matrix-js-sdk')
    
    this.client = sdk.createClient({
      baseUrl: this.config.homeserver,
      accessToken: this.config.accessToken,
      userId: this.config.userId,
      deviceId: this.config.deviceId,
      // TODO: Add crypto store for E2EE support
    }) as unknown as MatrixClient

    // Set up event handlers
    this.client.on('Room.timeline', this.handleTimelineEvent.bind(this))
    this.client.on('sync', this.handleSyncState.bind(this))
    
    if (this.config.autoJoin) {
      this.client.on('RoomMember.membership', this.handleMembership.bind(this))
    }

    // Start the client
    await this.client.startClient({
      initialSyncLimit: this.config.sync?.initialSyncLimit ?? 10,
    })

    console.log(`[matrix] Connected as ${this.config.userId}`)
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.stopClient()
      this.client = null
    }
    this._connected = false
    this.connectionHandler?.(false)
    console.log('[matrix] Disconnected')
  }

  onMessage(handler: (msg: ChatMessage) => void): void {
    this.messageHandler = handler
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandler = handler
  }

  async sendMessage(
    roomId: string, 
    content: string, 
    options?: SendOptions
  ): Promise<string> {
    if (!this.client) throw new Error('Not connected')

    const msgContent: Record<string, unknown> = {
      msgtype: 'm.text',
      body: content,
    }

    // Add formatted body for markdown/HTML
    if (options?.format === 'markdown' || options?.format === 'html') {
      msgContent.format = 'org.matrix.custom.html'
      msgContent.formatted_body = content // TODO: Convert markdown to HTML
    }

    // Add reply relation
    if (options?.replyTo) {
      msgContent['m.relates_to'] = {
        'm.in_reply_to': {
          event_id: options.replyTo,
        },
      }
    }

    // Add thread relation
    if (options?.threadId) {
      msgContent['m.relates_to'] = {
        rel_type: 'm.thread',
        event_id: options.threadId,
      }
    }

    const result = await this.client.sendMessage(roomId, msgContent)
    return result.event_id
  }

  async sendTyping(roomId: string, typing: boolean): Promise<void> {
    if (!this.client) return
    await this.client.sendTyping(roomId, typing, typing ? 30000 : undefined)
  }

  async sendReaction(roomId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) throw new Error('Not connected')
    
    await this.client.sendMessage(roomId, {
      'm.relates_to': {
        rel_type: 'm.annotation',
        event_id: messageId,
        key: emoji,
      },
    })
  }

  async getJoinedRooms(): Promise<string[]> {
    if (!this.client) return []
    const result = await this.client.getJoinedRooms()
    return result.joined_rooms
  }

  async getRoomName(roomId: string): Promise<string | undefined> {
    if (!this.client) return undefined
    const room = this.client.getRoom(roomId)
    return room?.name
  }

  // Private methods

  private handleTimelineEvent(event: unknown, room: unknown): void {
    // Type guards for matrix-js-sdk event objects
    const e = event as {
      getType(): string
      getSender(): string
      getContent(): { body?: string; msgtype?: string; url?: string; info?: { mimetype?: string; size?: number } }
      getId(): string
      getTs(): number
      event?: { content?: { 'm.relates_to'?: { 'm.in_reply_to'?: { event_id?: string } } } }
    }
    const r = room as { roomId: string }

    // Only handle message events
    if (e.getType() !== 'm.room.message') return

    // Ignore our own messages
    if (e.getSender() === this.config.userId) return

    const content = e.getContent()
    const body = content.body

    if (!body) return

    // Check if message is directed at us
    if (!this.isDirectedAtUs(body)) return

    // Build attachments list
    const attachments: Attachment[] = []
    if (content.msgtype === 'm.image' || content.msgtype === 'm.file') {
      attachments.push({
        mimeType: content.info?.mimetype ?? 'application/octet-stream',
        url: content.url ?? '',
        size: content.info?.size,
      })
    }

    // Extract reply-to if present
    const replyTo = e.event?.content?.['m.relates_to']?.['m.in_reply_to']?.event_id

    const message: ChatMessage = {
      roomId: r.roomId,
      senderId: e.getSender(),
      content: this.stripTrigger(body),
      messageId: e.getId(),
      timestamp: e.getTs(),
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo,
    }

    this.messageHandler?.(message)
  }

  private handleSyncState(...args: unknown[]): void {
    const state = args[0] as string
    const wasConnected = this._connected
    this._connected = state === 'PREPARED' || state === 'SYNCING'
    
    if (wasConnected !== this._connected) {
      this.connectionHandler?.(this._connected)
      console.log(`[matrix] Sync state: ${state}, connected: ${this._connected}`)
    }
  }

  private handleMembership(event: unknown, member: unknown): void {
    // Auto-join on invite
    const m = member as { membership: string; roomId: string }
    const e = event as { getSender(): string }
    
    if (m.membership === 'invite') {
      console.log(`[matrix] Invited to room ${m.roomId} by ${e.getSender()}`)
      // TODO: Auto-join logic
    }
  }

  private isDirectedAtUs(content: string): boolean {
    const patterns = this.config.triggerPatterns ?? []
    
    // Always respond in DMs (no trigger needed)
    // TODO: Check if room is DM
    
    // Check trigger patterns
    for (const pattern of patterns) {
      if (content.startsWith(pattern) || content.includes(pattern)) {
        return true
      }
    }

    // Check for @mention of our user ID
    if (content.includes(this.config.userId)) {
      return true
    }

    // Check for display name mention (simplified)
    const displayName = this.config.userId.split(':')[0].slice(1)
    if (content.toLowerCase().includes(`@${displayName.toLowerCase()}`)) {
      return true
    }

    return false
  }

  private stripTrigger(content: string): string {
    let result = content

    // Remove trigger patterns
    for (const pattern of this.config.triggerPatterns ?? []) {
      if (result.startsWith(pattern)) {
        result = result.slice(pattern.length).trim()
        break
      }
      // Also try removing from anywhere
      result = result.replace(pattern, '').trim()
    }

    // Remove @mentions of our user ID
    result = result.replace(this.config.userId, '').trim()

    // Remove display name mentions
    const displayName = this.config.userId.split(':')[0].slice(1)
    const mentionRegex = new RegExp(`@${displayName}:?`, 'gi')
    result = result.replace(mentionRegex, '').trim()

    return result
  }
}
