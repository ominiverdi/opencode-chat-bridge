#!/usr/bin/env bun
/**
 * Mattermost Connector for OpenCode Chat Bridge
 * 
 * Bridges Mattermost channels to OpenCode via ACP protocol.
 * Uses Mattermost REST API v4 + WebSocket for real-time events.
 * Zero external dependencies -- uses native fetch and WebSocket.
 * 
 * Usage:
 *   bun connectors/mattermost.ts
 * 
 * Environment variables:
 *   MATTERMOST_URL    - Server URL (e.g., https://mattermost.example.com)
 *   MATTERMOST_TOKEN  - Bot access token (from Integrations > Bot Accounts)
 *   MATTERMOST_TEAM   - Team name/slug (optional, auto-detected if bot is in one team)
 * 
 * Or configure via chat-bridge.json under the "mattermost" key.
 */

import fs from "fs"
import path from "path"
import { ACPClient, type ActivityEvent, type ImageContent } from "../src"
import { getConfig } from "../src/config"
import {
  BaseConnector,
  type BaseSession,
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
const TRIGGER = config.trigger
const BOT_NAME = config.botName
const RATE_LIMIT_SECONDS = config.rateLimitSeconds
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)

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
// Session Type
// =============================================================================

interface ChannelSession extends BaseSession {
  // Mattermost-specific fields can be added here if needed
}

// =============================================================================
// Mattermost Connector
// =============================================================================

class MattermostConnector extends BaseConnector<ChannelSession> {
  private ws: WebSocket | null = null
  private botUserId: string = ""
  private wsSeq: number = 1
  private reconnectAttempts: number = 0
  private maxReconnectAttempts: number = 10
  private reconnectDelay: number = 3000
  private pingInterval: NodeJS.Timer | null = null

  constructor() {
    super({
      connector: "mattermost",
      trigger: TRIGGER,
      botName: BOT_NAME,
      rateLimitSeconds: RATE_LIMIT_SECONDS,
      sessionRetentionDays: SESSION_RETENTION_DAYS,
    })
  }

  // ---------------------------------------------------------------------------
  // Abstract method implementations
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // Validate configuration
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
    await this.cleanupSessions()

    // Get bot user info
    try {
      const me = await mmApi("GET", "/users/me")
      this.botUserId = me.id
      console.log(`  Bot user: @${me.username} (${me.id})`)
    } catch (err) {
      this.logError("Failed to authenticate with Mattermost:", err)
      process.exit(1)
    }

    // Connect WebSocket
    await this.connectWebSocket()

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

  async sendMessage(channelId: string, text: string): Promise<void> {
    try {
      // Mattermost has a 16383 character limit per post
      const MAX_LEN = 16000
      if (text.length > MAX_LEN) {
        // Split into multiple messages
        const chunks = this.splitMessage(text, MAX_LEN)
        for (const chunk of chunks) {
          await mmApi("POST", "/posts", {
            channel_id: channelId,
            message: chunk,
          })
        }
      } else {
        await mmApi("POST", "/posts", {
          channel_id: channelId,
          message: text,
        })
      }
    } catch (err) {
      this.logError(`Failed to send message to ${channelId}:`, err)
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
        // Authenticate
        this.ws!.send(JSON.stringify({
          seq: this.wsSeq++,
          action: "authentication_challenge",
          data: { token: MM_TOKEN },
        }))
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string)

          // Auth response
          if (data.seq_reply === 1 && data.status === "OK") {
            this.log("WebSocket authenticated")
            this.reconnectAttempts = 0
            this.startPing()
            resolve()
            return
          }

          // Handle events
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

      // Timeout for initial connection
      setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          reject(new Error("WebSocket connection timeout"))
        }
      }, 15000)
    })
  }

  private startPing(): void {
    // Send ping every 30 seconds to keep connection alive
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

      // Ignore own messages
      if (post.user_id === this.botUserId) return

      // Ignore system messages
      if (post.type && post.type !== "") return

      const channelId = post.channel_id
      const message = (post.message || "").trim()
      if (!message) return

      // Check if this is a DM channel
      const channelType = data.data.channel_type || ""
      const isDM = channelType === "D"

      // Check ignore lists
      const ignoreChannels = config.mattermost.ignoreChannels || []
      const ignoreUsers = config.mattermost.ignoreUsers || []
      if (ignoreChannels.includes(channelId)) return
      if (ignoreUsers.includes(post.user_id)) return

      // Get sender username for logging
      const senderName = data.data.sender_name || post.user_id

      this.log(`[MSG] ${senderName}: ${message}`)

      // Extract query based on trigger or DM
      let query = ""
      if (message.startsWith(TRIGGER + " ")) {
        query = message.slice(TRIGGER.length + 1).trim()
      } else if (message.startsWith(TRIGGER)) {
        query = message.slice(TRIGGER.length).trim()
      } else if (isDM) {
        // In DM channels, respond to all messages without trigger
        query = message
      } else {
        return
      }

      if (!query) return

      // Handle commands
      if (query.startsWith("/")) {
        const cmdName = query.slice(1).split(" ")[0].toLowerCase()
        const bridgeCommands = ["status", "clear", "reset", "help"]
        if (bridgeCommands.includes(cmdName)) {
          const existingSession = this.sessionManager.get(channelId)
          const openCodeCommands = existingSession?.client.availableCommands || []
          await this.handleCommand(channelId, query, async (text) => {
            await this.sendMessage(channelId, text)
          }, { openCodeCommands })
          return
        }

        // Forward other /commands to OpenCode
        this.log(`[CMD] Forwarding to OpenCode: ${query}`)
        if (!this.checkRateLimit(post.user_id)) return
        await this.processQuery(channelId, post.user_id, query)
        return
      }

      // Rate limiting
      if (!this.checkRateLimit(post.user_id)) return

      this.log(`[QUERY] ${channelId}: ${query}`)
      await this.processQuery(channelId, post.user_id, query)
    } catch (err) {
      this.logError("Error handling posted event:", err)
    }
  }

  // ---------------------------------------------------------------------------
  // Query processing
  // ---------------------------------------------------------------------------

  private async processQuery(channelId: string, userId: string, query: string): Promise<void> {
    // Get or create session
    const session = await this.getOrCreateSession(channelId, (client) =>
      this.createSession(client)
    )

    if (!session) {
      await this.sendMessage(channelId, "Sorry, I couldn't connect to the AI service.")
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
    const sentToolOutputs = new Set<string>()

    // Activity events - show what the AI is doing
    const activityHandler = async (activity: ActivityEvent) => {
      if (activity.type === "tool_start" && activity.message !== lastActivityMessage) {
        lastActivityMessage = activity.message
        await this.sendMessage(channelId, `> ${activity.message}`)
      }
    }

    // Collect text chunks
    const chunkHandler = (text: string) => {
      responseBuffer += text
    }

    // Handle tool results and streaming
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
          await this.sendMessage(channelId, trimmed)
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
              await this.sendMessage(channelId, output)
              this.log(`[STREAM] Sent ${toolName} output (${output.length} chars)`)
            }
          }
        }
      }
    }

    // Handle images from tools
    const imageHandler = async (image: ImageContent) => {
      this.log(`Received image: ${image.mimeType}`)
      // TODO: upload base64 image to Mattermost
    }

    // Handle permission rejections
    const permissionHandler = async (event: { permission: string; path: string | null; message: string }) => {
      this.log(`[PERMISSION] Rejected: ${event.permission}${event.path ? ` (${event.path})` : ""}`)
      await this.sendMessage(channelId, `> ${event.message}`)
    }

    // Set up listeners
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
          await this.sendImageFromFile(channelId, imagePath)
          uploadedPaths.add(imagePath)
        }
      }

      // Process images from response
      const responsePaths = extractImagePaths(responseBuffer)
      for (const imagePath of responsePaths) {
        if (uploadedPaths.has(imagePath)) continue
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from response: ${imagePath}`)
          await this.sendImageFromFile(channelId, imagePath)
        }
      }

      // Send final response
      const cleanResponse = sanitizeServerPaths(removeImageMarkers(responseBuffer))
      if (cleanResponse) {
        const responsePreview = cleanResponse.slice(0, 100)
        const alreadySent = sentToolOutputs.has(responsePreview)

        if (!alreadySent) {
          session.outputChars += cleanResponse.length
          await this.sendMessage(channelId, cleanResponse)
        }
      }
    } catch (err) {
      this.logError("Error processing query:", err)
      await this.sendMessage(channelId, "Sorry, something went wrong processing your request.")
    } finally {
      client.off("activity", activityHandler)
      client.off("chunk", chunkHandler)
      client.off("update", updateHandler)
      client.off("image", imageHandler)
      client.off("permission_rejected", permissionHandler)
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

  private async sendImageFromFile(channelId: string, filePath: string): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        this.logError(`Image file not found: ${filePath}`)
        return
      }

      const fileId = await mmUploadFile(channelId, filePath)
      if (fileId) {
        await mmApi("POST", "/posts", {
          channel_id: channelId,
          message: "",
          file_ids: [fileId],
        })
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
      // Try to split at a newline
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

  // Handle shutdown
  process.on("SIGINT", async () => {
    await connector.stop()
    process.exit(0)
  })
  process.on("SIGTERM", async () => {
    await connector.stop()
    process.exit(0)
  })

  await connector.start()
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
