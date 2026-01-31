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
 *   WHATSAPP_ALLOWED_NUMBERS - Comma-separated phone numbers to respond to (optional)
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
  extractImagePaths,
  removeImageMarkers,
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
const TRIGGER = config.trigger
const BOT_NAME = config.botName
const RATE_LIMIT_SECONDS = config.rateLimitSeconds
const ALLOWED_NUMBERS = config.whatsapp.allowedNumbers
const AUTH_FOLDER = path.resolve(process.cwd(), config.whatsapp.authFolder)
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)

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

  constructor() {
    super({
      connector: "whatsapp",
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
    this.log("Starting...")
    console.log(`  Auth folder: ${AUTH_FOLDER}`)
    if (ALLOWED_NUMBERS.length > 0) {
      console.log(`  Allowed numbers: ${ALLOWED_NUMBERS.join(", ")}`)
    } else {
      console.log(`  Allowed numbers: ALL (no filter)`)
    }
    this.logStartup()
    await this.cleanupSessions()
    await this.connect()
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
      // Prefix with bot name so user knows who's writing
      const prefixedText = `${BOT_NAME}: ${text}`
      await this.sock.sendMessage(chatId, { text: prefixedText })
    } catch (err) {
      this.logError(`Failed to send message to ${chatId}:`, err)
    }
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
      const { connection, lastDisconnect, qr } = update

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
        this.myNumber = state.creds.me?.id?.split(":")[0] || ""
        this.log("Connected!")
        console.log(`  My number: ${this.myNumber}`)
        this.log("Listening for messages...")
      }
    })

    // Save credentials on update
    this.sock.ev.on("creds.update", saveCreds)

    // Handle incoming messages
    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
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

    // Extract phone number from JID (format: 1234567890@s.whatsapp.net)
    const phoneNumber = chatId.split("@")[0]

    // Check if number is allowed
    if (ALLOWED_NUMBERS.length > 0 && !ALLOWED_NUMBERS.includes(phoneNumber)) {
      this.log(`[IGNORED] Message from non-allowed number: ${phoneNumber}`)
      return
    }

    this.log(`[MSG] ${phoneNumber}: ${text}`)

    // Check trigger
    let query = ""
    if (text.startsWith(TRIGGER + " ")) {
      query = text.slice(TRIGGER.length + 1).trim()
    } else if (text.startsWith(TRIGGER)) {
      query = text.slice(TRIGGER.length).trim()
    } else {
      return
    }

    if (!query) return

    // Handle commands
    if (query.startsWith("/")) {
      await this.handleCommand(chatId, query, async (text) => {
        await this.sendMessage(chatId, text)
      })
      return
    }

    // Rate limiting
    if (!this.checkRateLimit(phoneNumber)) return

    this.log(`[QUERY] ${phoneNumber}: ${query}`)
    await this.processQuery(chatId, phoneNumber, query)
  }

  // ---------------------------------------------------------------------------
  // WhatsApp-specific: Query processing
  // ---------------------------------------------------------------------------

  private async processQuery(chatId: string, phoneNumber: string, query: string): Promise<void> {
    // Get or create session
    const session = await this.getOrCreateSession(chatId, (client) =>
      this.createSession(client)
    )

    if (!session) {
      await this.sendMessage(chatId, "Sorry, I couldn't connect to the AI service.")
      return
    }

    // Update session stats
    session.messageCount++
    session.lastActivity = new Date()
    session.inputChars += query.length

    const client = session.client

    // Track responses
    let responseBuffer = ""
    let toolResultsBuffer = ""
    let lastActivityMessage = ""

    // Activity events
    const activityHandler = async (activity: ActivityEvent) => {
      if (activity.type === "tool_start" && activity.message !== lastActivityMessage) {
        lastActivityMessage = activity.message
        await this.sendMessage(chatId, `> ${activity.message}`)
      }
    }

    // Collect text chunks
    const chunkHandler = (text: string) => {
      responseBuffer += text
    }

    // Capture tool results for image markers
    const updateHandler = (update: any) => {
      if (update.type === "tool_result" && update.toolResult) {
        toolResultsBuffer += update.toolResult
      }
    }

    // Handle images
    const imageHandler = async (image: ImageContent) => {
      this.log(`Received image: ${image.mimeType}`)
      await this.sendImageFromBase64(chatId, image)
    }

    // Set up listeners
    client.on("activity", activityHandler)
    client.on("chunk", chunkHandler)
    client.on("update", updateHandler)
    client.on("image", imageHandler)

    try {
      await client.prompt(query)

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

      // Clean response and send
      const cleanResponse = removeImageMarkers(responseBuffer)
      if (cleanResponse) {
        session.outputChars += cleanResponse.length
        await this.sendMessage(chatId, cleanResponse)
      }
    } catch (err) {
      this.logError("Error processing query:", err)
      await this.sendMessage(chatId, "Sorry, something went wrong processing your request.")
    } finally {
      client.off("activity", activityHandler)
      client.off("chunk", chunkHandler)
      client.off("update", updateHandler)
      client.off("image", imageHandler)
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
