#!/usr/bin/env bun
/**
 * WhatsApp Connector for OpenCode Chat Bridge
 * 
 * Bridges WhatsApp to OpenCode via ACP protocol using Baileys.
 * Uses WebSocket connection (no browser needed).
 * 
 * Usage:
 *   bun connectors/whatsapp.ts
 * 
 * First run will show a QR code - scan with WhatsApp to link.
 * Session is saved to .whatsapp-auth/ for reconnection.
 * 
 * Environment variables:
 *   WHATSAPP_TRIGGER - Message prefix to trigger bot (default: !oc)
 *   WHATSAPP_ALLOWED_USERS - Comma-separated WhatsApp sender IDs to respond to (optional)
 */

import fs from "fs"
import path from "path"
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "baileys"
import { Boom } from "@hapi/boom"
import * as qrcode from "qrcode-terminal"
import { ACPClient, type ActivityEvent, type ImageContent } from "../src"
import { getConfig } from "../src/config"
import {
  BaseConnector,
  type BaseSession,
  parseCsvList,
  formatToolCallMessage,
  shouldShowToolOutput,
  extractImagePaths,
  extractDocPaths,
  removeImageMarkers,
  removeDocMarkers,
  sanitizeServerPaths,
} from "../src"

// =============================================================================
// Configuration
// =============================================================================

// Simple logger for Baileys
const logger = {
  level: "silent" as const,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: console.warn,
  error: console.error,
  fatal: console.error,
  child: () => logger,
}

const config = getConfig()
const TRIGGER = process.env.WHATSAPP_TRIGGER || config.trigger
const BOT_NAME = config.botName
const RATE_LIMIT_SECONDS = config.rateLimitSeconds
const ENV_ALLOWED_USERS = parseCsvList(process.env.WHATSAPP_ALLOWED_USERS)
const ALLOWED_USERS = ENV_ALLOWED_USERS.length > 0 ? ENV_ALLOWED_USERS : config.whatsapp.allowedUsers
const AUTH_FOLDER = path.resolve(process.cwd(), config.whatsapp.authFolder)
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)
const RESPOND_TO_OTHERS = process.env.WHATSAPP_RESPOND_TO_OTHERS === undefined
  ? config.whatsapp.respondToOthers
  : !["0", "false", "no", "off"].includes(process.env.WHATSAPP_RESPOND_TO_OTHERS.toLowerCase())

// =============================================================================
// Session Type
// =============================================================================

interface ChatSession extends BaseSession {
  // WhatsApp-specific fields can be added here if needed
}

// =============================================================================
// WhatsApp Connector
// =============================================================================

class WhatsAppConnector extends BaseConnector<ChatSession> {
  private sock: ReturnType<typeof makeWASocket> | null = null
  private myNumber: string = ""
  private ownIds = new Set<string>()

  constructor() {
    super({
      connector: "whatsapp",
      trigger: TRIGGER,
      botName: BOT_NAME,
      rateLimitSeconds: RATE_LIMIT_SECONDS,
      sessionRetentionDays: SESSION_RETENTION_DAYS,
      allowedUsers: ALLOWED_USERS,
    })
  }

  // ---------------------------------------------------------------------------
  // Abstract method implementations
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.logStartup()
    console.log(`  Auth folder: ${AUTH_FOLDER}`)
    await this.cleanupSessions()
    await this.connect()
    this.startSessionExpiryLoop()
  }

  async stop(): Promise<void> {
    this.log("Stopping...")
    await this.disconnectAllSessions()

    if (this.sock) {
      this.sock.end(undefined)
    }

    this.log("Stopped.")
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.sock) return

    try {
      const MAX_LEN = 4000 // Conservative limit for WhatsApp messages
      const prefixed = `${BOT_NAME}: ${text}`

      if (prefixed.length <= MAX_LEN) {
        await this.sock.sendMessage(chatId, { text: prefixed })
      } else {
        // Split long messages — first chunk gets the bot name prefix
        const chunks = this.splitMessage(text, MAX_LEN - BOT_NAME.length - 2)
        for (let i = 0; i < chunks.length; i++) {
          const msg = i === 0 ? `${BOT_NAME}: ${chunks[i]}` : chunks[i]
          await this.sock.sendMessage(chatId, { text: msg })
        }
      }
    } catch (err) {
      this.logError(`Failed to send message to ${chatId}:`, err)
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

  // ---------------------------------------------------------------------------
  // WhatsApp-specific: Connection
  // ---------------------------------------------------------------------------

  private async connect(): Promise<void> {
    // Load or create auth state
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
    const { version } = await fetchLatestBaileysVersion()

    this.log(`Using Baileys version: ${version.join(".")}`)

    // Create socket
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger as any),
      },
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
    })

    // Handle connection updates
    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications } = update

      if (qr) {
        console.log("\n=== Scan this QR code with WhatsApp ===\n")
        qrcode.generate(qr, { small: true })
        console.log("\nOpen WhatsApp > Settings > Linked Devices > Link a Device\n")
      }

      if (connection === "close") {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode
        const shouldReconnect = reason !== DisconnectReason.loggedOut

        this.log(`Connection closed. Reason: ${DisconnectReason[reason] || reason}`)

        if (shouldReconnect) {
          this.log("Reconnecting...")
          await this.connect()
        } else {
          this.log("Logged out. Delete .whatsapp-auth/ and restart to re-authenticate.")
        }
      }

      if (connection === "open") {
        const me = state.creds.me as { id?: string; lid?: string } | undefined
        this.myNumber = this.extractWhatsAppUserId(me?.id || "")
        this.updateOwnIds(me?.id, me?.lid)
        this.log("Connected!")
        console.log(`  My number: ${this.myNumber}`)
        console.log(`  Own IDs: ${Array.from(this.ownIds).join(", ") || "pending"}`)
        console.log(`  Respond to others: ${RESPOND_TO_OTHERS ? "yes" : "no"}`)
        this.log("Listening for messages...")
      }

      if (receivedPendingNotifications) {
        this.log("Initial sync complete (received all pending notifications).")
      }
    })

    // Save credentials on update
    this.sock.ev.on("creds.update", (creds) => {
      const me = creds.me as { id?: string; lid?: string } | undefined
      this.updateOwnIds(me?.id, me?.lid)
      saveCreds()
    })

    // Handle incoming messages
    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") {
        if (type === "append") {
          this.log(`Ignoring history sync messages (type: ${type})`)
        } else {
          this.log(`Ignoring non-notify upsert (type: ${type})`)
        }
        return
      }

      for (const msg of messages) {

        await this.handleMessage(msg)
      }
    })
  }

  // ---------------------------------------------------------------------------
  // WhatsApp-specific: Message handling
  // ---------------------------------------------------------------------------

  private async handleMessage(msg: any): Promise<void> {
    const chatId = msg.key.remoteJid
    if (!chatId) return

    // Get message text
    const text = msg.message?.conversation ||
                 msg.message?.extendedTextMessage?.text ||
                 ""

    if (!text) return

    // Skip messages that start with our bot name (our own responses)
    if (text.startsWith(`${BOT_NAME}:`)) return

    // Extract sender ID from the sender JID. In recent WhatsApp/Baileys this may
    // be a LID (`...@lid`) rather than a phone-number JID. In groups,
    // `remoteJid` is the group and `participant` is the actual sender.
    const senderJid = msg.key.participant || msg.participant || chatId
    const senderId = this.extractWhatsAppUserId(senderJid)

    const isOwnerMessage = msg.key?.fromMe === true

    // Personal WhatsApp bridges can be restricted to the linked account only.
    if (!RESPOND_TO_OTHERS && !isOwnerMessage) return

    // Check if non-owner senders are allowed. The linked account is always
    // allowed so personal self-chat UX does not depend on brittle PN/LID strings.
    if (!isOwnerMessage && !this.isUserAllowed(senderId)) return

    // Deduplicate events
    const dedupeId = msg.key.id || `${chatId}:${Date.now()}`
    if (this.isDuplicateEvent(dedupeId)) return

    this.log(`[MSG] ${senderId}: ${text}`)

    // Check trigger. Bridge-local slash commands may be sent bare on WhatsApp
    // for quick mobile use, e.g. /h, /p, /s, /d. In the linked account's
    // self-chat, plain text is also treated as a prompt.
    let query = ""
    if (text.startsWith(TRIGGER + " ")) {
      query = text.slice(TRIGGER.length + 1).trim()
    } else if (text.startsWith(TRIGGER)) {
      query = text.slice(TRIGGER.length).trim()
    } else if (this.isBareBridgeCommand(text)) {
      query = text.trim()
    } else if (this.isSelfChatMessage(msg)) {
      query = text.trim()
    } else {
      return
    }

    if (!query) return

    await this.stopMirrorForUserActivity(chatId, query, async (text) => {
      await this.sendMessage(chatId, text)
    })

    // Handle commands
    if (query.startsWith("/")) {
      await this.handleCommand(chatId, query, async (text) => {
        await this.sendMessage(chatId, text)
      })
      return
    }

    // Rate limiting
    if (!this.checkRateLimit(senderId)) return

    this.log(`[QUERY] ${senderId}: ${query}`)
    await this.processQuery(chatId, senderId, query)
  }

  private extractWhatsAppUserId(jid: string): string {
    return jid.split("@")[0]?.split(":")[0] || jid
  }

  private updateOwnIds(...jids: Array<string | undefined>): void {
    for (const jid of jids) {
      const id = this.extractWhatsAppUserId(jid || "")
      if (id) this.ownIds.add(id)
    }
  }

  private isSelfChatMessage(msg: any): boolean {
    if (msg.key?.fromMe !== true) return false
    const chatId = this.extractWhatsAppUserId(msg.key?.remoteJid || "")
    return Boolean(chatId && this.ownIds.has(chatId))
  }

  private isBareBridgeCommand(text: string): boolean {
    if (!this.isSessionPickerEnabled()) return false
    const trimmed = text.trim()
    if (!trimmed.startsWith("/")) return false
    const cmd = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase()
    return ["h", "help", "p", "projects", "s", "sessions", "m", "mirror", "r", "reload", "d", "detach", "status", "clear", "reset"].includes(cmd)
  }

  // ---------------------------------------------------------------------------
  // WhatsApp-specific: Query processing
  // ---------------------------------------------------------------------------

  private async processQuery(chatId: string, senderId: string, query: string): Promise<void> {
    const startTime = Date.now()

    // WhatsApp uses "latest message wins": abort the old OpenCode process and
    // drop its cached session so the new request never reuses a disconnected client.
    if (this.isQueryActive(chatId)) {
      this.log(`[ABORT] New query from ${senderId}, aborting previous...`)
      this.abortQuery(chatId)
    }

    // Get or create session
    const session = await this.getOrCreateSession(chatId, (client) =>
      this.createSession(client)
    )

    if (!session) {
      await this.sendMessage(chatId, "Sorry, I couldn't connect to the AI service.")
      return
    }

    const activeQuery = this.markQueryActive(chatId, () => {
      this.log(`[ABORT-EXEC] Disconnecting ACP client for ${chatId}`)
      this.sessionManager.delete(chatId)
      void session.client.disconnect()
    })

    // Update session stats
    session.messageCount++
    session.lastActivity = new Date()
    session.inputChars += query.length

    const client = session.client

    // Track responses
    let responseBuffer = ""
    let toolResultsBuffer = ""
    let lastActivityMessage = ""
    let toolCallCount = 0
    const sentToolOutputs = new Set<string>()

    // Activity events
    const activityHandler = async (activity: ActivityEvent) => {
      if (activity.type === "tool_start") {
        toolCallCount++
        const message = formatToolCallMessage(activity, config.toolMessages)
        if (message && message !== lastActivityMessage) {
          lastActivityMessage = message
          await this.sendMessage(chatId, `> ${message}`)
        }
      }
    }

    // Collect text chunks
    const chunkHandler = (text: string) => {
      responseBuffer += text
    }

    // Capture tool results for image markers and optional chat output.
    const updateHandler = async (update: any) => {
      if (update.type === "tool_result" && update.toolResult) {
        toolResultsBuffer += update.toolResult
        const toolName = update.toolName || ""
        if (!shouldShowToolOutput(toolName, config.toolMessages)) return

        const result = update.toolResult.length > 2000
          ? update.toolResult.slice(0, 2000) + "\n... (truncated)"
          : update.toolResult
        const output = result.trim()
        const key = output.slice(0, 100)
        if (output && !sentToolOutputs.has(key)) {
          sentToolOutputs.add(key)
          await this.sendMessage(chatId, output)
        }
      }

      if (update.type === "tool_output_delta" && update.partialOutput) {
        const toolName = update.toolName || ""
        if (!shouldShowToolOutput(toolName, config.toolMessages)) return

        const output = update.partialOutput.trim()
        const key = output.slice(0, 100)
        if (output && !sentToolOutputs.has(key)) {
          sentToolOutputs.add(key)
          await this.sendMessage(chatId, output)
        }
      }
    }

    // Handle images
    const imageHandler = async (image: ImageContent) => {
      this.log(`Received image: ${image.mimeType}`)
      await this.sendImageFromBase64(chatId, image)
    }

    // Handle permission rejections
    const permissionHandler = async (event: { permission: string; path: string | null; message: string }) => {
      this.log(`[PERMISSION] Rejected: ${event.permission}${event.path ? ` (${event.path})` : ""}`)
      await this.sendMessage(chatId, `> ${event.message}`)
    }

    // Set up listeners
    client.on("activity", activityHandler)
    client.on("chunk", chunkHandler)
    client.on("update", updateHandler)
    client.on("image", imageHandler)
    client.on("permission_rejected", permissionHandler)

    // Timeout to prevent stuck requests (5 minutes)
    const QUERY_TIMEOUT_MS = 5 * 60 * 1000
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Request timed out")), QUERY_TIMEOUT_MS)
    })

    try {
      await Promise.race([client.prompt(query), timeoutPromise])

      // Process images from tool results
      const uploadedPaths = new Set<string>()
      const toolPaths = extractImagePaths(toolResultsBuffer)
      for (const imagePath of toolPaths) {
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from tool result: ${imagePath}`)
          await this.sendImageFromFile(chatId, imagePath)
          uploadedPaths.add(imagePath)
        }
      }

      // Process images from response (model might echo paths)
      const responsePaths = extractImagePaths(responseBuffer)
      for (const imagePath of responsePaths) {
        if (uploadedPaths.has(imagePath)) continue
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from response: ${imagePath}`)
          await this.sendImageFromFile(chatId, imagePath)
        }
      }

      // Process documents from tool results
      const uploadedDocPaths = new Set<string>()
      const toolDocPaths = extractDocPaths(toolResultsBuffer)
      for (const docPath of toolDocPaths) {
        if (fs.existsSync(docPath)) {
          this.log(`Uploading document from tool result: ${docPath}`)
          await this.sendDocumentFromFile(chatId, docPath)
          uploadedDocPaths.add(docPath)
        }
      }

      // Process documents from response (model might echo paths)
      const responseDocPaths = extractDocPaths(responseBuffer)
      for (const docPath of responseDocPaths) {
        if (uploadedDocPaths.has(docPath)) continue
        if (fs.existsSync(docPath)) {
          this.log(`Uploading document from response: ${docPath}`)
          await this.sendDocumentFromFile(chatId, docPath)
        }
      }

      // Clean response and send
      const cleanResponse = sanitizeServerPaths(removeDocMarkers(removeImageMarkers(responseBuffer)))
      if (cleanResponse) {
        session.outputChars += cleanResponse.length
        await this.sendMessage(chatId, cleanResponse)
      } else if (toolCallCount > 0) {
        await this.sendMessage(chatId, "He procesado la consulta pero no he podido generar una respuesta. Intentalo de nuevo.")
      }
      // Log elapsed time
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const outChars = cleanResponse ? cleanResponse.length : 0
      const tools = toolCallCount > 0 ? `, ${toolCallCount} tool${toolCallCount > 1 ? "s" : ""}` : ""
      this.log(`[DONE] ${elapsed}s (${outChars} chars${tools})`)
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      if (this.wasQueryAborted(activeQuery)) {
        this.log(`[CANCELLED] ${elapsed}s: superseded by a newer WhatsApp query`)
      } else {
        this.logError(`[FAIL] ${elapsed}s:`, err)
        await this.sendMessage(chatId, "Sorry, something went wrong processing your request.")
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      client.off("activity", activityHandler)
      client.off("chunk", chunkHandler)
      client.off("update", updateHandler)
      client.off("image", imageHandler)
      client.off("permission_rejected", permissionHandler)
      session.lastActivity = new Date()
      this.markQueryDone(chatId, activeQuery)
    }
  }

  private createSession(client: ACPClient): ChatSession {
    return {
      ...this.createBaseSession(client),
    }
  }

  // ---------------------------------------------------------------------------
  // WhatsApp-specific: Image sending
  // ---------------------------------------------------------------------------

  private async sendImageFromBase64(chatId: string, image: ImageContent): Promise<void> {
    if (!this.sock) return

    try {
      const buffer = Buffer.from(image.data, "base64")
      await this.sock.sendMessage(chatId, {
        image: buffer,
        caption: image.alt || undefined,
      })
      this.log(`Sent image to ${chatId}`)
    } catch (err) {
      this.logError(`Failed to send image to ${chatId}:`, err)
      await this.sendMessage(chatId, `[Image: ${image.alt || "Unable to display"}]`)
    }
  }

  private async sendImageFromFile(chatId: string, filePath: string): Promise<void> {
    if (!this.sock) return

    try {
      const buffer = fs.readFileSync(filePath)
      const fileName = path.basename(filePath)

      await this.sock.sendMessage(chatId, {
        image: buffer,
        caption: fileName,
      })
      this.log(`Sent image from file to ${chatId}: ${filePath}`)
    } catch (err) {
      this.logError(`Failed to send image from file to ${chatId}:`, err)
    }
  }

  // ---------------------------------------------------------------------------
  // WhatsApp-specific: Document sending
  // ---------------------------------------------------------------------------

  private async sendDocumentFromFile(chatId: string, filePath: string): Promise<void> {
    if (!this.sock) return

    try {
      const buffer = fs.readFileSync(filePath)
      const fileName = path.basename(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const mimeTypes: Record<string, string> = {
        ".pdf": "application/pdf",
        ".csv": "text/csv",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".txt": "text/plain",
        ".json": "application/json",
        ".zip": "application/zip",
      }

      await this.sock.sendMessage(chatId, {
        document: buffer,
        mimetype: mimeTypes[ext] || "application/octet-stream",
        fileName: fileName,
      })
      this.log(`Sent document to ${chatId}: ${filePath}`)
    } catch (err) {
      this.logError(`Failed to send document to ${chatId}:`, err)
    }
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const connector = new WhatsAppConnector()

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
