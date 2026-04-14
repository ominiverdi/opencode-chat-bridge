#!/usr/bin/env bun
/**
 * Mattermost Connector for OpenCode Chat Bridge
 *
 * Bridges Mattermost channels to OpenCode via ACP protocol.
 * Uses Mattermost REST API v4 + WebSocket for real-time events.
 * Zero external dependencies -- uses native fetch and WebSocket.
 *
 * Thread Isolation (configurable via chat-bridge.json mattermost.threadIsolation):
 *   When enabled, sessions are keyed on channel:rootPostId so each Mattermost
 *   thread gets its own isolated OpenCode session. Plain replies within a thread
 *   are forwarded to the bot automatically.
 *
 * Usage:
 *   bun connectors/mattermost.ts
 *
 * Environment variables:
 *   MATTERMOST_URL    - Server URL (e.g., https://mattermost.example.com)
 *   MATTERMOST_TOKEN  - Bot access token (from Integrations > Bot Accounts)
 *   MATTERMOST_TEAM   - Team name/slug (optional, auto-detected if bot is in one team)
 */

import fs from "fs"
import path from "path"
import { ACPClient, type ActivityEvent, type ImageContent } from "../src"
import { getConfig } from "../src/config"
import {
  BaseConnector,
  type BaseSession,
  parseCsvList,
  extractImagePaths,
  removeImageMarkers,
  sanitizeServerPaths,
} from "../src"

// =============================================================================
// Configuration
// =============================================================================

const config = getConfig()
const MM_URL = (config.mattermost.url || process.env.MATTERMOST_URL || "").replace(/\/+$/, "")
const MM_TOKEN = config.mattermost.token || process.env.MATTERMOST_TOKEN || ""
const MM_TEAM = config.mattermost.teamName || process.env.MATTERMOST_TEAM || ""
const TRIGGER = process.env.MATTERMOST_TRIGGER || config.trigger
const BOT_NAME = config.botName
const RATE_LIMIT_SECONDS = config.rateLimitSeconds
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)
const THREAD_ISOLATION = config.mattermost.threadIsolation
const ENV_ALLOWED_USERS = parseCsvList(process.env.MATTERMOST_ALLOWED_USERS)
const ALLOWED_USERS = ENV_ALLOWED_USERS.length > 0 ? ENV_ALLOWED_USERS : config.mattermost.allowedUsers

// =============================================================================
// Mattermost API helpers
// =============================================================================

/**
 * Make an authenticated request to the Mattermost REST API v4
 */
async function mmApi(method: string, endpoint: string, body?: any): Promise<any> {
  const url = `${MM_URL}/api/v4${endpoint}`
  const opts: RequestInit = {
    method,
    headers: {
      "Authorization": `Bearer ${MM_TOKEN}`,
      "Content-Type": "application/json",
    },
  }
  if (body) {
    opts.body = JSON.stringify(body)
  }

  const res = await fetch(url, opts)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Mattermost API ${method} ${endpoint}: ${res.status} ${text}`)
  }

  // Some endpoints return 204 No Content
  if (res.status === 204) return null
  return res.json()
}

/**
 * Upload a file to Mattermost
 */
async function mmUploadFile(channelId: string, filePath: string): Promise<string | null> {
  const url = `${MM_URL}/api/v4/files`
  const form = new FormData()
  form.append("channel_id", channelId)

  const buffer = fs.readFileSync(filePath)
  const fileName = path.basename(filePath)
  form.append("files", new Blob([buffer]), fileName)

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MM_TOKEN}`,
    },
    body: form,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`File upload failed: ${res.status} ${text}`)
  }

  const data = await res.json()
  return data.file_infos?.[0]?.id || null
}

// =============================================================================
// Thread Context Helpers (pure, exported for testing)
// =============================================================================

/**
 * Normalized context extracted from a Mattermost posted event.
 */
export interface MattermostEventContext {
  channelId: string
  userId: string
  text: string
  postId: string
  /** Non-empty when this post is a thread reply */
  rootId: string
  /** The root post ID to use when replying (rootId or postId for top-level) */
  replyRootId: string
  /** Session key: channel:rootPostId (thread isolation) or channel (per-channel) */
  sessionId: string
  /** Idempotency key: channel:postId */
  dedupeId: string
}

/**
 * Resolve the thread root post ID.
 * If the post has a root_id it is a reply; otherwise the post itself starts the thread.
 */
export function resolveRootId(rootId: string | undefined, postId: string): string {
  return rootId || postId
}

/**
 * Build the session key.
 * When threadIsolation is true: channel:rootPostId (per-thread)
 * When false: channel (per-channel, old behavior)
 */
export function buildMattermostSessionId(
  channelId: string,
  replyRootId: string,
  threadIsolation: boolean
): string {
  if (threadIsolation) {
    return `${channelId}:${replyRootId}`
  }
  return channelId
}

/**
 * Normalize raw Mattermost post fields into a consistent MattermostEventContext.
 */
export function normalizeMattermostEventContext(
  input: {
    channelId: string
    userId?: string
    text?: string
    postId: string
    rootId?: string
  },
  threadIsolation: boolean
): MattermostEventContext {
  const channelId = input.channelId
  const postId = input.postId
  const rootId = input.rootId || ""
  const replyRootId = resolveRootId(rootId || undefined, postId)

  return {
    channelId,
    userId: input.userId || "unknown",
    text: input.text || "",
    postId,
    rootId,
    replyRootId,
    sessionId: buildMattermostSessionId(channelId, replyRootId, threadIsolation),
    dedupeId: `${channelId}:${postId}`,
  }
}

/**
 * Returns true if a plain thread reply (no trigger, no mention) should be
 * considered for forwarding to the bot.
 * The caller must still check whether an active session exists for the thread.
 */
export function shouldHandleThreadReply(input: {
  text: string
  rootId: string
  trigger: string
  botUsername: string
}): boolean {
  const text = input.text.trim()
  if (!text) return false
  if (!input.rootId) return false
  if (text.toLowerCase().startsWith(`${input.trigger.toLowerCase()} `)) return false
  if (text.toLowerCase().startsWith(`${input.trigger.toLowerCase()}`)) return false
  if (text.startsWith(`@${input.botUsername} `)) return false
  if (text.startsWith(`@${input.botUsername}`)) return false
  return true
}

// =============================================================================
// Session Type
// =============================================================================

interface ChannelSession extends BaseSession {}

// =============================================================================
// Mattermost Connector
// =============================================================================

export class MattermostConnector extends BaseConnector<ChannelSession> {
  private ws: WebSocket | null = null
  private botUserId: string = ""
  private botUsername: string = ""
  private wsSeq: number = 1
  private reconnectAttempts: number = 0
  private maxReconnectAttempts: number = 10
  private reconnectDelay: number = 3000
  private pingInterval: NodeJS.Timer | null = null
  private threadIsolation: boolean

  constructor() {
    super({
      connector: "mattermost",
      trigger: TRIGGER,
      botName: BOT_NAME,
      rateLimitSeconds: RATE_LIMIT_SECONDS,
      sessionRetentionDays: SESSION_RETENTION_DAYS,
      allowedUsers: ALLOWED_USERS,
    })
    this.threadIsolation = THREAD_ISOLATION
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (!MM_URL) {
      console.error("Error: MATTERMOST_URL not set")
      console.error("Set it in .env or chat-bridge.json mattermost.url")
      process.exit(1)
    }
    if (!MM_TOKEN) {
      console.error("Error: MATTERMOST_TOKEN not set")
      console.error("Create a bot at: Integrations > Bot Accounts")
      process.exit(1)
    }

    this.log("Starting...")
    console.log(`  Server: ${MM_URL}`)
    this.logStartup()
    console.log(`  Thread isolation: ${this.threadIsolation ? "on (per-thread sessions)" : "off (per-channel sessions)"}`)
    await this.cleanupSessions()

    // Get bot user info
    try {
      const me = await mmApi("GET", "/users/me")
      this.botUserId = me.id
      this.botUsername = me.username
      console.log(`  Bot user: @${me.username} (${me.id})`)
      if (config.mattermost.respondToMentions) {
        console.log(`  Responds to: trigger "${TRIGGER}" and @${me.username} mentions`)
      }
    } catch (err) {
      this.logError("Failed to authenticate with Mattermost:", err)
      process.exit(1)
    }

    await this.connectWebSocket()

    this.startSessionExpiryLoop()
    this.log("Started! Listening for messages...")
  }

  async stop(): Promise<void> {
    this.log("Stopping...")
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    await this.disconnectAllSessions()
    this.log("Stopped.")
  }

  /**
   * Send a message to a channel, optionally as a thread reply.
   */
  async sendMessage(channelId: string, text: string, rootId?: string): Promise<void> {
    try {
      const MAX_LEN = 16000
      const payload: any = { channel_id: channelId }
      if (rootId) payload.root_id = rootId

      if (text.length > MAX_LEN) {
        const chunks = this.splitMessage(text, MAX_LEN)
        for (const chunk of chunks) {
          await mmApi("POST", "/posts", { ...payload, message: chunk })
        }
      } else {
        await mmApi("POST", "/posts", { ...payload, message: text })
      }
    } catch (err) {
      this.logError(`Failed to send message to ${channelId}:`, err)
    }
  }

  /**
   * Send a reply, respecting threadIsolation config.
   */
  private async sendReply(context: MattermostEventContext, text: string): Promise<void> {
    if (this.threadIsolation) {
      await this.sendMessage(context.channelId, text, context.replyRootId)
    } else {
      await this.sendMessage(context.channelId, text)
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = MM_URL.replace(/^https/, "wss").replace(/^http/, "ws")
        + "/api/v4/websocket"

      this.log(`Connecting WebSocket: ${wsUrl}`)
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        this.log("WebSocket connected, authenticating...")
        this.wsSeq = 1
        this.ws!.send(JSON.stringify({
          seq: this.wsSeq++,
          action: "authentication_challenge",
          data: { token: MM_TOKEN },
        }))
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string)

          if (data.seq_reply === 1 && data.status === "OK") {
            this.log("WebSocket authenticated")
            this.reconnectAttempts = 0
            this.startPing()
            resolve()
            return
          }

          if (data.event === "posted") {
            this.handlePostedEvent(data)
          }
        } catch (err) {
          this.logError("WebSocket message parse error:", err)
        }
      }

      this.ws.onerror = (event) => {
        this.logError("WebSocket error:", event)
      }

      this.ws.onclose = (event) => {
        this.log(`WebSocket closed: ${event.code} ${event.reason}`)
        if (this.pingInterval) {
          clearInterval(this.pingInterval)
          this.pingInterval = null
        }
        this.handleReconnect()
      }

      setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          reject(new Error("WebSocket connection timeout"))
        }
      }, 15000)
    })
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          seq: this.wsSeq++,
          action: "ping",
        }))
      }
    }, 30000)
  }

  private async handleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logError("Max reconnect attempts reached, exiting")
      process.exit(1)
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5)
    this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`)

    await new Promise(resolve => setTimeout(resolve, delay))

    try {
      await this.connectWebSocket()
      this.log("Reconnected successfully")
    } catch (err) {
      this.logError("Reconnect failed:", err)
    }
  }

  // ---------------------------------------------------------------------------
  // Event handling
  // ---------------------------------------------------------------------------

  private async handlePostedEvent(data: any): Promise<void> {
    try {
      const post = JSON.parse(data.data.post)

      // Ignore own messages and system messages
      if (post.user_id === this.botUserId) return
      if (post.type && post.type !== "") return

      const message = (post.message || "").trim()
      if (!message) return

      const context = normalizeMattermostEventContext({
        channelId: post.channel_id,
        userId: post.user_id,
        text: message,
        postId: post.id,
        rootId: post.root_id || "",
      }, this.threadIsolation)

      // Deduplicate events (WebSocket replays)
      if (this.isDuplicateEvent(context.dedupeId)) return

      // Check if this is a DM channel
      const channelType = data.data.channel_type || ""
      const isDM = channelType === "D"

      // Check ignore lists
      const ignoreChannels = config.mattermost.ignoreChannels || []
      const ignoreUsers = config.mattermost.ignoreUsers || []
      if (ignoreChannels.includes(context.channelId)) return
      if (ignoreUsers.includes(context.userId)) return
      if (!this.isUserAllowed(context.userId)) return

      const senderName = data.data.sender_name || context.userId

      // Extract query based on trigger, @mention, or DM
      let query = ""
      const mention = `@${this.botUsername}`
      if (message.startsWith(TRIGGER + " ")) {
        query = message.slice(TRIGGER.length + 1).trim()
      } else if (message.startsWith(TRIGGER)) {
        query = message.slice(TRIGGER.length).trim()
      } else if (config.mattermost.respondToMentions && message.startsWith(mention + " ")) {
        query = message.slice(mention.length + 1).trim()
      } else if (config.mattermost.respondToMentions && message.startsWith(mention)) {
        query = message.slice(mention.length).trim()
      } else if (isDM) {
        query = message
      } else if (this.threadIsolation && shouldHandleThreadReply({
        text: message,
        rootId: context.rootId,
        trigger: TRIGGER,
        botUsername: this.botUsername,
      }) && this.sessionManager.has(context.sessionId)) {
        // Implicit thread follow-up: plain reply in a thread with an active session
        query = message
        this.log(`[THREAD] ${senderName} in ${context.sessionId}: ${message}`)
      } else {
        return
      }

      if (!query) return

      // Touch session activity
      const existingSession = this.sessionManager.get(context.sessionId)
      if (existingSession) existingSession.lastActivity = new Date()

      this.log(`[MSG] ${senderName} in ${context.sessionId}: ${message}`)

      // Handle commands
      if (query.startsWith("/")) {
        const cmdName = query.slice(1).split(" ")[0].toLowerCase()
        const bridgeCommands = ["status", "clear", "reset", "help"]
        if (bridgeCommands.includes(cmdName)) {
          const openCodeCommands = existingSession?.client.availableCommands || []
          await this.handleCommand(context.sessionId, query, async (text) => {
            await this.sendReply(context, text)
          }, { openCodeCommands })
          return
        }

        // Forward other /commands to OpenCode
        this.log(`[CMD] Forwarding to OpenCode: ${query}`)
        if (!this.checkRateLimit(context.userId)) return
        await this.processQuery(context, query)
        return
      }

      // Rate limiting
      if (!this.checkRateLimit(context.userId)) return

      this.log(`[QUERY] ${context.sessionId}: ${query}`)
      await this.processQuery(context, query)
    } catch (err) {
      this.logError("Error handling posted event:", err)
    }
  }

  // ---------------------------------------------------------------------------
  // Query processing
  // ---------------------------------------------------------------------------

  private async processQuery(context: MattermostEventContext, query: string): Promise<void> {
    const startTime = Date.now()

    // Guard against concurrent queries on the same session
    if (this.isQueryActive(context.sessionId)) {
      await this.sendReply(context, "A request is already running. Please wait for it to finish.")
      return
    }
    this.markQueryActive(context.sessionId)

    // Get or create session
    const session = await this.getOrCreateSession(context.sessionId, (client) =>
      this.createSession(client)
    )

    if (!session) {
      await this.sendReply(context, "Sorry, I couldn't connect to the AI service.")
      return
    }

    // Update session stats
    session.messageCount++
    session.lastActivity = new Date()
    session.inputChars += query.length

    const client = session.client

    // Track response chunks
    let responseBuffer = ""
    let toolResultsBuffer = ""
    let lastActivityMessage = ""
    let toolCallCount = 0
    const sentToolOutputs = new Set<string>()

    const activityHandler = async (activity: ActivityEvent) => {
      if (activity.type === "tool_start") {
        toolCallCount++
        if (activity.message !== lastActivityMessage) {
          lastActivityMessage = activity.message
          await this.sendReply(context, `> ${activity.message}`)
        }
      }
    }

    const chunkHandler = (text: string) => {
      responseBuffer += text
    }

    const updateHandler = async (update: any) => {
      if (update.type === "tool_result" && update.toolResult) {
        toolResultsBuffer += update.toolResult

        const toolName = update.toolName || ""
        const streamTools = config.streamTools || ["bash"]
        const shouldShow = streamTools.some((t: string) => toolName.includes(t))

        if (!shouldShow) {
          this.log(`[RESULT] Skipping ${toolName} result (not in streamTools)`)
          return
        }

        const maxLen = 2000
        const result = update.toolResult.length > maxLen
          ? update.toolResult.slice(0, maxLen) + "\n... (truncated)"
          : update.toolResult

        const trimmed = result.trim()
        if (!trimmed) return

        const contentHash = trimmed.slice(0, 100)
        if (sentToolOutputs.has(contentHash)) return

        sentToolOutputs.add(contentHash)
        try {
          await this.sendReply(context, trimmed)
        } catch (err) {
          this.log(`[RESULT] Error sending: ${err}`)
        }
      }

      // Stream partial tool output
      if (update.type === "tool_output_delta" && update.partialOutput) {
        const toolName = update.toolName || ""
        const streamTools = config.streamTools || ["bash"]
        const shouldStream = streamTools.some((t: string) => toolName.includes(t))

        if (shouldStream) {
          const output = update.partialOutput.trim()
          if (output) {
            const contentHash = output.slice(0, 100)
            if (!sentToolOutputs.has(contentHash)) {
              sentToolOutputs.add(contentHash)
              await this.sendReply(context, output)
              this.log(`[STREAM] Sent ${toolName} output (${output.length} chars)`)
            }
          }
        }
      }
    }

    const imageHandler = async (image: ImageContent) => {
      this.log(`Received image: ${image.mimeType}`)
    }

    const permissionHandler = async (event: { permission: string; path: string | null; message: string }) => {
      this.log(`[PERMISSION] Rejected: ${event.permission}${event.path ? ` (${event.path})` : ""}`)
      await this.sendReply(context, `> ${event.message}`)
    }

    client.on("activity", activityHandler)
    client.on("chunk", chunkHandler)
    client.on("update", updateHandler)
    client.on("image", imageHandler)
    client.on("permission_rejected", permissionHandler)

    try {
      await client.prompt(query)

      // Process images from tool results
      const uploadedPaths = new Set<string>()
      const toolPaths = extractImagePaths(toolResultsBuffer)
      for (const imagePath of toolPaths) {
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from tool result: ${imagePath}`)
          await this.sendImageFromFile(context.channelId, imagePath, this.threadIsolation ? context.replyRootId : undefined)
          uploadedPaths.add(imagePath)
        }
      }

      // Process images from response
      const responsePaths = extractImagePaths(responseBuffer)
      for (const imagePath of responsePaths) {
        if (uploadedPaths.has(imagePath)) continue
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from response: ${imagePath}`)
          await this.sendImageFromFile(context.channelId, imagePath, this.threadIsolation ? context.replyRootId : undefined)
        }
      }

      // Send final response (never deduplicate against tool outputs)
      const cleanResponse = sanitizeServerPaths(removeImageMarkers(responseBuffer))
      if (cleanResponse) {
        session.outputChars += cleanResponse.length
        await this.sendReply(context, cleanResponse)
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const outChars = cleanResponse ? cleanResponse.length : 0
      const tools = toolCallCount > 0 ? `, ${toolCallCount} tool${toolCallCount > 1 ? "s" : ""}` : ""
      this.log(`[DONE] ${elapsed}s (${outChars} chars${tools}) [${context.sessionId}]`)
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      this.logError(`[FAIL] ${elapsed}s [${context.sessionId}]:`, err)
      await this.sendReply(context, "Sorry, something went wrong processing your request.")
    } finally {
      client.off("activity", activityHandler)
      client.off("chunk", chunkHandler)
      client.off("update", updateHandler)
      client.off("image", imageHandler)
      client.off("permission_rejected", permissionHandler)
      if (session) session.lastActivity = new Date()
      this.markQueryDone(context.sessionId)
    }
  }

  private createSession(client: ACPClient): ChannelSession {
    return {
      ...this.createBaseSession(client),
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async sendImageFromFile(channelId: string, filePath: string, rootId?: string): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        this.logError(`Image file not found: ${filePath}`)
        return
      }

      const fileId = await mmUploadFile(channelId, filePath)
      if (fileId) {
        const payload: any = {
          channel_id: channelId,
          message: "",
          file_ids: [fileId],
        }
        if (rootId) payload.root_id = rootId
        await mmApi("POST", "/posts", payload)
        this.log(`Sent image to ${channelId}: ${path.basename(filePath)}`)
      }
    } catch (err) {
      this.logError(`Failed to send image to ${channelId}:`, err)
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining)
        break
      }
      let splitAt = remaining.lastIndexOf("\n", maxLen)
      if (splitAt <= 0) splitAt = maxLen
      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).trimStart()
    }
    return chunks
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const connector = new MattermostConnector()
  process.on("SIGINT", async () => { await connector.stop(); process.exit(0) })
  process.on("SIGTERM", async () => { await connector.stop(); process.exit(0) })
  await connector.start()
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err)
    process.exit(1)
  })
}
