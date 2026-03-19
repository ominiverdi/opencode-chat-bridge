#!/usr/bin/env bun
/**
 * Matrix Connector for OpenCode Chat Bridge
 *
 * Bridges Matrix rooms to OpenCode via ACP protocol.
 * Uses matrix-bot-sdk with native Rust crypto for E2EE support.
 *
 * Thread Isolation (configurable via chat-bridge.json matrix.threadIsolation):
 *   When enabled, sessions are keyed on room:threadRootEventId so each
 *   Matrix thread gets its own isolated OpenCode session. Plain replies
 *   within a thread are forwarded automatically.
 *
 * Usage:
 *   bun connectors/matrix.ts
 *
 * Environment variables (see .env.example):
 *   MATRIX_HOMESERVER - Matrix server URL (e.g., https://matrix.org)
 *   MATRIX_ACCESS_TOKEN - Bot access token (or use PASSWORD for auto-login)
 *   MATRIX_PASSWORD - Bot password (will login and save token)
 *   MATRIX_USER_ID - Bot user ID (e.g., @mybot:matrix.org)
 *   MATRIX_TRIGGER - Message prefix to trigger bot (default: !oc)
 */

import fs from "fs"
import path from "path"
import os from "os"

// matrix-bot-sdk with native Rust crypto for E2EE
import {
  AutojoinRoomsMixin,
  LogLevel,
  LogService,
  MatrixAuth,
  MatrixClient,
  MessageEvent,
  RichConsoleLogger,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
} from "matrix-bot-sdk"

import { ACPClient, type ActivityEvent, type ImageContent } from "../src"
import { getConfig } from "../src/config"
import { marked } from "marked"
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
const HOMESERVER = config.matrix.homeserver
const ACCESS_TOKEN = config.matrix.accessToken || process.env.MATRIX_ACCESS_TOKEN
const PASSWORD = config.matrix.password || process.env.MATRIX_PASSWORD
const USER_ID = config.matrix.userId || process.env.MATRIX_USER_ID
const TRIGGER = process.env.MATRIX_TRIGGER || config.trigger
const BOT_NAME = config.botName
const RATE_LIMIT_SECONDS = config.rateLimitSeconds
const FORMAT_HTML = config.matrix.formatHtml || false
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)
const THREAD_ISOLATION = config.matrix.threadIsolation

// Storage paths
const STORAGE_PATH = process.env.MATRIX_STORAGE_PATH ||
  path.join(os.homedir(), ".local", "share", "opencode-matrix-bot")
const STATE_STORAGE_PATH = path.join(STORAGE_PATH, "bot-state.json")
const CRYPTO_STORAGE_PATH = path.join(STORAGE_PATH, "crypto")
const TOKEN_FILE_PATH = path.join(STORAGE_PATH, "access_token")

// =============================================================================
// Thread Context Helpers (imported from standalone file for testability)
// =============================================================================

export {
  type MatrixEventContext,
  extractThreadRootId,
  resolveThreadRoot,
  buildMatrixSessionId,
  normalizeMatrixEventContext,
  buildThreadRelation,
  shouldHandleThreadReply,
} from "./matrix-thread-helpers"
import {
  type MatrixEventContext,
  extractThreadRootId,
  normalizeMatrixEventContext,
  buildThreadRelation,
  shouldHandleThreadReply,
} from "./matrix-thread-helpers"

// =============================================================================
// Session Type
// =============================================================================

interface RoomSession extends BaseSession {
  /** Track the last event ID sent in each thread for m.in_reply_to fallback */
  lastEventIds: Map<string, string>
}

// =============================================================================
// Matrix Connector
// =============================================================================

export class MatrixConnector extends BaseConnector<RoomSession> {
  private matrix: MatrixClient | null = null
  private threadIsolation: boolean

  constructor() {
    super({
      connector: "matrix",
      trigger: TRIGGER,
      botName: BOT_NAME,
      rateLimitSeconds: RATE_LIMIT_SECONDS,
      sessionRetentionDays: SESSION_RETENTION_DAYS,
    })
    this.threadIsolation = THREAD_ISOLATION
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (!ACCESS_TOKEN && !PASSWORD) {
      console.error("Error: Either MATRIX_ACCESS_TOKEN or MATRIX_PASSWORD must be set")
      console.error("Password-based login will save the token for future use.")
      process.exit(1)
    }

    this.log("Starting...")
    console.log(`  Homeserver: ${HOMESERVER}`)
    console.log(`  User: ${USER_ID}`)
    console.log(`  Storage: ${STORAGE_PATH}`)
    console.log(`  E2EE: enabled (Rust crypto with SQLite)`)
    this.logStartup()
    console.log(`  Thread isolation: ${this.threadIsolation ? "on (per-thread sessions)" : "off (per-room sessions)"}`)
    await this.cleanupSessions()

    fs.mkdirSync(STORAGE_PATH, { recursive: true })
    fs.mkdirSync(CRYPTO_STORAGE_PATH, { recursive: true })

    let accessToken = await this.getOrCreateAccessToken()
    if (!accessToken) {
      console.error("Error: Could not obtain access token")
      process.exit(1)
    }

    LogService.setLogger(new RichConsoleLogger())
    LogService.setLevel(LogLevel.INFO)
    LogService.muteModule("Metrics")

    const stateStorage = new SimpleFsStorageProvider(STATE_STORAGE_PATH)
    const cryptoStorage = new RustSdkCryptoStorageProvider(CRYPTO_STORAGE_PATH)

    this.matrix = new MatrixClient(HOMESERVER, accessToken, stateStorage, cryptoStorage)
    AutojoinRoomsMixin.setupOnClient(this.matrix)

    this.matrix.on("room.failed_decryption", async (roomId: string, event: any, error: Error) => {
      this.log(`[CRYPTO] Failed to decrypt in ${roomId}: ${error.message}`)
    })

    this.matrix.on("room.message", this.handleRoomMessage.bind(this))
    await this.matrix.start()

    this.startSessionExpiryLoop()
    this.log("Started! Listening for messages...")
  }

  async stop(): Promise<void> {
    this.log("Stopping...")
    await this.disconnectAllSessions()
    if (this.matrix) this.matrix.stop()
    this.log("Stopped.")
  }

  async sendMessage(roomId: string, text: string): Promise<void> {
    try {
      if (FORMAT_HTML) {
        const html = await marked.parse(text)
        await this.matrix!.sendMessage(roomId, {
          msgtype: "m.text",
          body: text,
          format: "org.matrix.custom.html",
          formatted_body: html,
        })
      } else {
        await this.matrix!.sendText(roomId, text)
      }
    } catch (err) {
      this.logError(`Failed to send message to ${roomId}:`, err)
    }
  }

  /**
   * Send a reply, respecting threadIsolation config.
   * When true: send as thread reply with m.relates_to.
   * When false: send plain message to room.
   * Returns the event ID of the sent message (for tracking lastEventId).
   */
  private async sendReply(context: MatrixEventContext, text: string): Promise<string | null> {
    try {
      if (this.threadIsolation) {
        const session = this.sessionManager.get(context.sessionId)
        const lastEventId = session?.lastEventIds.get(context.replyThreadRootId) || context.replyThreadRootId
        const relation = buildThreadRelation(context.replyThreadRootId, lastEventId)

        let content: any
        if (FORMAT_HTML) {
          const html = await marked.parse(text)
          content = {
            msgtype: "m.text",
            body: text,
            format: "org.matrix.custom.html",
            formatted_body: html,
            "m.relates_to": relation,
          }
        } else {
          content = {
            msgtype: "m.text",
            body: text,
            "m.relates_to": relation,
          }
        }

        const eventId = await this.matrix!.sendMessage(context.roomId, content)
        // Track for next m.in_reply_to
        if (session && eventId) {
          session.lastEventIds.set(context.replyThreadRootId, eventId)
        }
        return eventId
      } else {
        await this.sendMessage(context.roomId, text)
        return null
      }
    } catch (err) {
      this.logError(`Failed to send reply to ${context.roomId}:`, err)
      return null
    }
  }

  /**
   * Send a notice (for tool activity), respecting thread isolation.
   */
  private async sendNoticeReply(context: MatrixEventContext, text: string): Promise<void> {
    try {
      if (this.threadIsolation) {
        const session = this.sessionManager.get(context.sessionId)
        const lastEventId = session?.lastEventIds.get(context.replyThreadRootId) || context.replyThreadRootId
        const relation = buildThreadRelation(context.replyThreadRootId, lastEventId)

        const eventId = await this.matrix!.sendMessage(context.roomId, {
          msgtype: "m.notice",
          body: text,
          "m.relates_to": relation,
        })
        if (session && eventId) {
          session.lastEventIds.set(context.replyThreadRootId, eventId)
        }
      } else {
        await this.matrix!.sendNotice(context.roomId, text)
      }
    } catch (err) {
      this.logError(`Failed to send notice to ${context.roomId}:`, err)
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  private async getOrCreateAccessToken(): Promise<string | null> {
    if (ACCESS_TOKEN) {
      this.log("Using access token from config/env")
      return ACCESS_TOKEN
    }
    if (fs.existsSync(TOKEN_FILE_PATH)) {
      const savedToken = fs.readFileSync(TOKEN_FILE_PATH, "utf-8").trim()
      if (savedToken) {
        this.log("Using saved access token")
        return savedToken
      }
    }
    if (PASSWORD) {
      return await this.loginWithPassword()
    }
    return null
  }

  private async loginWithPassword(): Promise<string | null> {
    this.log("Logging in with password...")
    try {
      const auth = new MatrixAuth(HOMESERVER)
      const username = USER_ID!.split(":")[0].replace("@", "")
      const client = await auth.passwordLogin(username, PASSWORD!, "OpenCode Chat Bridge")
      const accessToken = client.accessToken
      fs.writeFileSync(TOKEN_FILE_PATH, accessToken)
      this.log(`Login successful! Token saved to ${TOKEN_FILE_PATH}`)
      return accessToken
    } catch (err: any) {
      this.logError("Password login failed:", err.message || err)
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Event handling
  // ---------------------------------------------------------------------------

  private async handleRoomMessage(roomId: string, event: any): Promise<void> {
    const message = new MessageEvent(event)

    if (message.messageType !== "m.text") return

    const myUserId = await this.matrix!.getUserId()
    if (message.sender === myUserId) return

    const body = message.textBody.trim()
    if (!body) return

    // Deduplicate events (Matrix sync replays)
    if (this.isDuplicateEvent(event.event_id || `${roomId}:${Date.now()}`)) return

    const threadRootEventId = extractThreadRootId(event)

    const context = normalizeMatrixEventContext({
      roomId,
      sender: message.sender,
      text: body,
      eventId: event.event_id,
      threadRootEventId,
    }, this.threadIsolation)

    // Touch session activity
    const existingSession = this.sessionManager.get(context.sessionId)
    if (existingSession) existingSession.lastActivity = new Date()

    // Check if this is a DM
    const members = await this.matrix!.getJoinedRoomMembers(roomId)
    const isDM = members.length === 2

    // Extract query
    let query = ""
    if (body.startsWith(TRIGGER + " ")) {
      query = body.slice(TRIGGER.length + 1).trim()
    } else if (body.startsWith(TRIGGER)) {
      query = body.slice(TRIGGER.length).trim()
    } else if (body.includes(myUserId)) {
      query = body.replace(myUserId, "").trim()
    } else if (body.match(/^@?bot[:\s]/i)) {
      query = body.replace(/^@?bot[:\s]*/i, "").trim()
    } else if (isDM) {
      query = body
    } else if (this.threadIsolation && shouldHandleThreadReply({
      text: body,
      threadRootEventId,
      trigger: TRIGGER,
      botUserId: myUserId,
    }) && this.sessionManager.has(context.sessionId)) {
      // Implicit thread follow-up
      query = body
      this.log(`[THREAD] ${message.sender} in ${context.sessionId}: ${body}`)
    } else {
      return
    }

    query = query.replace(/^[:\s]+/, "").trim()
    if (!query) return

    this.log(`[MSG] ${message.sender} in ${context.sessionId}: ${body}`)

    // Handle commands
    if (query.startsWith("/")) {
      const cmdName = query.slice(1).split(" ")[0].toLowerCase()
      const bridgeCommands = ["status", "clear", "reset", "help"]
      if (bridgeCommands.includes(cmdName)) {
        const openCodeCommands = existingSession?.client.availableCommands || []
        await this.handleCommand(context.sessionId, query, async (text) => {
          await this.sendNoticeReply(context, text)
        }, { openCodeCommands })
        return
      }

      this.log(`[CMD] Forwarding to OpenCode: ${query}`)
      if (!this.checkRateLimit(message.sender)) return
      await this.processQuery(context, query)
      return
    }

    if (!this.checkRateLimit(message.sender)) return
    await this.processQuery(context, query)
  }

  // ---------------------------------------------------------------------------
  // Query processing
  // ---------------------------------------------------------------------------

  private async processQuery(context: MatrixEventContext, query: string): Promise<void> {
    const startTime = Date.now()

    if (this.isQueryActive(context.sessionId)) {
      await this.sendReply(context, "A request is already running. Please wait for it to finish.")
      return
    }
    this.markQueryActive(context.sessionId)

    const session = await this.getOrCreateSession(context.sessionId, (client) =>
      this.createSession(client)
    )

    if (!session) {
      await this.sendReply(context, "Sorry, I couldn't connect to the AI service.")
      return
    }

    session.messageCount++
    session.lastActivity = new Date()
    session.inputChars += query.length
    // Track the incoming event for m.in_reply_to chain
    session.lastEventIds.set(context.replyThreadRootId, context.eventId)

    const client = session.client

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
          await this.sendNoticeReply(context, `> ${activity.message}`)
        }
      }
    }

    const chunkHandler = (text: string) => { responseBuffer += text }

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
      await this.sendImageFromBase64(context, image)
    }

    const permissionHandler = async (event: { permission: string; path: string | null; message: string }) => {
      this.log(`[PERMISSION] Rejected: ${event.permission}${event.path ? ` (${event.path})` : ""}`)
      await this.sendNoticeReply(context, `> ${event.message}`)
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
          await this.sendImageFromFile(context, imagePath)
          uploadedPaths.add(imagePath)
        }
      }

      const responsePaths = extractImagePaths(responseBuffer)
      for (const imagePath of responsePaths) {
        if (uploadedPaths.has(imagePath)) continue
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from response: ${imagePath}`)
          await this.sendImageFromFile(context, imagePath)
        }
      }

      const cleanResponse = sanitizeServerPaths(removeImageMarkers(responseBuffer))
      if (cleanResponse) {
        const responsePreview = cleanResponse.slice(0, 100)
        const alreadySent = sentToolOutputs.has(responsePreview)

        if (!alreadySent) {
          session.outputChars += cleanResponse.length
          await this.sendReply(context, cleanResponse)
        }
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

  private createSession(client: ACPClient): RoomSession {
    return {
      ...this.createBaseSession(client),
      lastEventIds: new Map(),
    }
  }

  // ---------------------------------------------------------------------------
  // Image sending (thread-aware)
  // ---------------------------------------------------------------------------

  private async sendImageFromBase64(context: MatrixEventContext, image: ImageContent): Promise<void> {
    try {
      const buffer = Buffer.from(image.data, "base64")
      const mxcUrl = await this.matrix!.uploadContent(buffer, image.mimeType, image.alt || "image.png")

      const content: any = {
        msgtype: "m.image",
        body: image.alt || "Image",
        url: mxcUrl,
        info: { mimetype: image.mimeType, size: buffer.length },
      }

      if (this.threadIsolation) {
        const session = this.sessionManager.get(context.sessionId)
        const lastEventId = session?.lastEventIds.get(context.replyThreadRootId) || context.replyThreadRootId
        content["m.relates_to"] = buildThreadRelation(context.replyThreadRootId, lastEventId)
      }

      const eventId = await this.matrix!.sendMessage(context.roomId, content)
      if (this.threadIsolation) {
        const session = this.sessionManager.get(context.sessionId)
        if (session && eventId) {
          session.lastEventIds.set(context.replyThreadRootId, eventId)
        }
      }

      this.log(`Sent image to ${context.roomId}: ${mxcUrl}`)
    } catch (err) {
      this.logError(`Failed to send image to ${context.roomId}:`, err)
      await this.sendReply(context, `[Image: ${image.alt || "Unable to display"}]`)
    }
  }

  private async sendImageFromFile(context: MatrixEventContext, filePath: string): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        this.logError(`Image file not found: ${filePath}`)
        return
      }

      const buffer = fs.readFileSync(filePath)
      const fileName = path.basename(filePath)
      const mxcUrl = await this.matrix!.uploadContent(buffer, "image/png", fileName)

      const content: any = {
        msgtype: "m.image",
        body: fileName,
        url: mxcUrl,
        info: { mimetype: "image/png", size: buffer.length },
      }

      if (this.threadIsolation) {
        const session = this.sessionManager.get(context.sessionId)
        const lastEventId = session?.lastEventIds.get(context.replyThreadRootId) || context.replyThreadRootId
        content["m.relates_to"] = buildThreadRelation(context.replyThreadRootId, lastEventId)
      }

      const eventId = await this.matrix!.sendMessage(context.roomId, content)
      if (this.threadIsolation) {
        const session = this.sessionManager.get(context.sessionId)
        if (session && eventId) {
          session.lastEventIds.set(context.replyThreadRootId, eventId)
        }
      }

      this.log(`Sent image from file to ${context.roomId}: ${mxcUrl}`)
    } catch (err) {
      this.logError(`Failed to send image from file to ${context.roomId}:`, err)
    }
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const connector = new MatrixConnector()
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
