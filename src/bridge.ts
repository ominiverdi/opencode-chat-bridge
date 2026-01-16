/**
 * Core Bridge Logic - Connects chat protocols to OpenCode.
 * 
 * This is the heart of the plugin. It:
 * - Receives messages from chat protocols
 * - Creates/retrieves OpenCode sessions
 * - Sends prompts to OpenCode
 * - Streams responses back to chat
 */

import type { ChatProtocol, ChatMessage } from './protocols/base'
import { SessionManager } from './session-manager'

// OpenCode SDK client type (simplified for our needs)
export interface BridgeOpenCodeClient {
  session: {
    create(opts: { body: { title?: string; parentID?: string } }): Promise<{ data: { id: string } }>
    get(opts: { path: { id: string } }): Promise<{ data: { id: string; title?: string } }>
    prompt(opts: { 
      path: { id: string }
      body: { 
        parts: Array<{ type: string; text?: string }>
        model?: { providerID: string; modelID: string }
        agent?: string
      }
    }): Promise<{ data: { info: unknown; parts: Array<{ type: string; text?: string }> } }>
    abort(opts: { path: { id: string } }): Promise<void>
  }
  event: {
    subscribe(): Promise<{ stream: AsyncIterable<BridgeEvent> }>
  }
}

interface BridgeEvent {
  type: string
  properties: Record<string, unknown>
}

export interface BridgeConfig {
  /** Session manager instance */
  sessionManager: SessionManager
  /** Default agent to use */
  defaultAgent?: string
  /** Mode command mappings (e.g., "!s" -> "serious") */
  modes?: Record<string, string>
  /** Maximum message length before truncation */
  maxMessageLength?: number
  /** Whether to show typing indicators */
  showTyping?: boolean
}

export class Bridge {
  private protocols = new Map<string, ChatProtocol>()
  private config: BridgeConfig
  private eventSubscription?: AsyncIterable<BridgeEvent>

  constructor(
    private client: BridgeOpenCodeClient,
    config: Partial<BridgeConfig> = {}
  ) {
    this.config = {
      sessionManager: config.sessionManager ?? new SessionManager(),
      defaultAgent: config.defaultAgent,
      modes: config.modes ?? {},
      maxMessageLength: config.maxMessageLength ?? 4000,
      showTyping: config.showTyping ?? true,
      ...config,
    }
  }

  /**
   * Register a chat protocol
   */
  addProtocol(protocol: ChatProtocol): void {
    this.protocols.set(protocol.name, protocol)
    
    // Set up message handler
    protocol.onMessage(async (msg) => {
      try {
        await this.handleMessage(protocol, msg)
      } catch (error) {
        console.error(`[bridge] Error handling message from ${protocol.name}:`, error)
        // Try to send error message back to chat
        try {
          await protocol.sendMessage(
            msg.roomId,
            `Error processing message: ${error instanceof Error ? error.message : 'Unknown error'}`
          )
        } catch {
          // Ignore send errors
        }
      }
    })
  }

  /**
   * Start the bridge - connect all protocols
   */
  async start(): Promise<void> {
    // Load persisted session mappings
    await this.config.sessionManager.load()

    // Connect all protocols
    for (const [name, protocol] of this.protocols) {
      try {
        await protocol.connect()
        console.log(`[bridge] Connected protocol: ${name}`)
      } catch (error) {
        console.error(`[bridge] Failed to connect protocol ${name}:`, error)
      }
    }

    // Subscribe to OpenCode events for streaming
    // TODO: Implement streaming responses
    // this.eventSubscription = await this.client.event.subscribe()

    console.log(`[bridge] Started with ${this.protocols.size} protocol(s)`)
  }

  /**
   * Stop the bridge - disconnect all protocols
   */
  async stop(): Promise<void> {
    for (const [name, protocol] of this.protocols) {
      try {
        await protocol.disconnect()
        console.log(`[bridge] Disconnected protocol: ${name}`)
      } catch (error) {
        console.error(`[bridge] Error disconnecting ${name}:`, error)
      }
    }
    this.protocols.clear()
    console.log('[bridge] Stopped')
  }

  /**
   * Handle an incoming message from a chat protocol
   */
  private async handleMessage(protocol: ChatProtocol, msg: ChatMessage): Promise<void> {
    console.log(`[bridge] Message from ${protocol.name}:${msg.roomId}: ${msg.content.slice(0, 50)}...`)

    // Parse mode command from message
    const { content, agent } = this.parseMode(msg.content)

    // Show typing indicator
    if (this.config.showTyping) {
      await protocol.sendTyping(msg.roomId, true)
    }

    try {
      // Get or create session for this room
      let sessionId = this.config.sessionManager.getSession(protocol.name, msg.roomId)
      
      if (!sessionId) {
        // Create new session
        const roomName = await protocol.getRoomName?.(msg.roomId)
        const title = roomName 
          ? `${protocol.name}: ${roomName}`
          : `${protocol.name}:${msg.roomId.slice(0, 20)}`
        
        const session = await this.client.session.create({
          body: { title }
        })
        sessionId = session.data.id
        this.config.sessionManager.setSession(protocol.name, msg.roomId, sessionId, title)
        console.log(`[bridge] Created session ${sessionId} for ${protocol.name}:${msg.roomId}`)
      }

      // Update activity timestamp
      this.config.sessionManager.touch(protocol.name, msg.roomId)

      // Send message to OpenCode
      const result = await this.client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: content }],
          agent: agent ?? this.config.defaultAgent,
        }
      })

      // Extract text response from parts
      const response = this.extractResponse(result.data.parts)

      // Stop typing indicator
      if (this.config.showTyping) {
        await protocol.sendTyping(msg.roomId, false)
      }

      // Send response (may need to split if too long)
      await this.sendResponse(protocol, msg.roomId, response, msg.messageId)

    } catch (error) {
      // Stop typing indicator on error
      if (this.config.showTyping) {
        await protocol.sendTyping(msg.roomId, false)
      }
      throw error
    }
  }

  /**
   * Parse mode command from message content
   * Returns cleaned content and optional agent name
   */
  private parseMode(content: string): { content: string; agent?: string } {
    const trimmed = content.trim()
    
    for (const [prefix, agentName] of Object.entries(this.config.modes ?? {})) {
      if (trimmed.startsWith(prefix + ' ') || trimmed === prefix) {
        return {
          content: trimmed.slice(prefix.length).trim(),
          agent: agentName,
        }
      }
    }

    return { content: trimmed }
  }

  /**
   * Extract text response from OpenCode message parts
   */
  private extractResponse(parts: Array<{ type: string; text?: string }>): string {
    const textParts = parts
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text!)
    
    return textParts.join('\n\n') || 'No response generated.'
  }

  /**
   * Send response to chat, splitting if necessary
   */
  private async sendResponse(
    protocol: ChatProtocol,
    roomId: string,
    response: string,
    replyTo?: string
  ): Promise<void> {
    const maxLen = this.config.maxMessageLength ?? 4000

    if (response.length <= maxLen) {
      await protocol.sendMessage(roomId, response, { 
        format: 'markdown',
        replyTo 
      })
      return
    }

    // Split into chunks, trying to break at paragraph boundaries
    const chunks = this.splitResponse(response, maxLen)
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = i === 0 
        ? chunks[i] 
        : `... (${i + 1}/${chunks.length})\n\n${chunks[i]}`
      
      await protocol.sendMessage(roomId, chunk, {
        format: 'markdown',
        replyTo: i === 0 ? replyTo : undefined,
      })
    }
  }

  /**
   * Split long response into chunks at paragraph boundaries
   */
  private splitResponse(text: string, maxLen: number): string[] {
    const chunks: string[] = []
    let current = ''

    const paragraphs = text.split(/\n\n+/)
    
    for (const para of paragraphs) {
      if (current.length + para.length + 2 <= maxLen) {
        current += (current ? '\n\n' : '') + para
      } else if (para.length > maxLen) {
        // Paragraph itself is too long, split at sentence boundaries
        if (current) {
          chunks.push(current)
          current = ''
        }
        const sentences = para.split(/(?<=[.!?])\s+/)
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 <= maxLen) {
            current += (current ? ' ' : '') + sentence
          } else {
            if (current) chunks.push(current)
            current = sentence.slice(0, maxLen)
          }
        }
      } else {
        chunks.push(current)
        current = para
      }
    }

    if (current) chunks.push(current)
    return chunks
  }
}
