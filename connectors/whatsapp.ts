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
 *   WHATSAPP_ALLOWED_NUMBERS - Comma-separated phone numbers to respond to (optional, e.g., "1234567890,0987654321")
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "baileys"
import { Boom } from "@hapi/boom"
import * as qrcode from "qrcode-terminal"
import * as fs from "fs"
import * as path from "path"
import { ACPClient, type ActivityEvent, type ImageContent } from "../src"
import { getConfig } from "../src/config"
import { getSessionDir, ensureSessionDir, cleanupOldSessions, getSessionStorageInfo, estimateTokens } from "../src/session-utils"

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

// Load configuration
const config = getConfig()
const TRIGGER = config.trigger
const BOT_NAME = config.botName
const RATE_LIMIT_SECONDS = config.rateLimitSeconds
const ALLOWED_NUMBERS = config.whatsapp.allowedNumbers
const AUTH_FOLDER = path.resolve(process.cwd(), config.whatsapp.authFolder)
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)

// Rate limiting
const userLastMessage = new Map<string, number>()

// Per-chat ACP sessions
interface ChatSession {
  client: ACPClient
  createdAt: Date
  messageCount: number
  lastActivity: Date
  inputChars: number    // Characters from user
  outputChars: number   // Characters from bot responses
}
const chatSessions = new Map<string, ChatSession>()

class WhatsAppConnector {
  private sock: ReturnType<typeof makeWASocket> | null = null
  private myNumber: string = ""
  
  async start(): Promise<void> {
    console.log("Starting WhatsApp connector...")
    console.log(`  Trigger: ${TRIGGER}`)
    console.log(`  Bot name: ${BOT_NAME}`)
    console.log(`  Auth folder: ${AUTH_FOLDER}`)
    if (ALLOWED_NUMBERS.length > 0) {
      console.log(`  Allowed numbers: ${ALLOWED_NUMBERS.join(", ")}`)
    } else {
      console.log(`  Allowed numbers: ALL (no filter)`)
    }
    
    // Log session storage location
    const storageInfo = getSessionStorageInfo()
    console.log(`  Session storage: ${storageInfo.baseDir}`)
    console.log(`    (${storageInfo.source})`)
    
    // Cleanup old sessions
    console.log("Cleaning up old sessions...")
    const cleaned = cleanupOldSessions("whatsapp", SESSION_RETENTION_DAYS)
    if (cleaned > 0) {
      console.log(`  Cleaned up ${cleaned} session(s) older than ${SESSION_RETENTION_DAYS} days`)
    } else {
      console.log(`  No old sessions to clean`)
    }
    
    await this.connect()
  }
  
  private async connect(): Promise<void> {
    // Load or create auth state
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
    const { version } = await fetchLatestBaileysVersion()
    
    console.log(`Using Baileys version: ${version.join(".")}`)
    
    // Create socket
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger as any),
      },
      printQRInTerminal: false, // We'll handle QR ourselves
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
        
        console.log(`Connection closed. Reason: ${DisconnectReason[reason] || reason}`)
        
        if (shouldReconnect) {
          console.log("Reconnecting...")
          await this.connect()
        } else {
          console.log("Logged out. Delete .whatsapp-auth/ and restart to re-authenticate.")
        }
      }
      
      if (connection === "open") {
        // Extract our phone number from credentials
        this.myNumber = state.creds.me?.id?.split(":")[0] || ""
        console.log("WhatsApp connected!")
        console.log(`  My number: ${this.myNumber}`)
        console.log("Listening for messages...")
      }
    })
    
    // Save credentials on update
    this.sock.ev.on("creds.update", saveCreds)
    
    // Handle incoming messages
    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      console.log(`[EVENT] messages.upsert type=${type} count=${messages.length}`)
      
      for (const msg of messages) {
        console.log(`[RAW] from=${msg.key.remoteJid} fromMe=${msg.key.fromMe}`)
        await this.handleMessage(msg)
      }
    })
  }
  
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
      console.log(`[IGNORED] Message from non-allowed number: ${phoneNumber}`)
      return
    }
    
    console.log(`[MSG] ${phoneNumber}: ${text}`)
    
    // Check trigger
    let query = ""
    if (text.startsWith(TRIGGER + " ")) {
      query = text.slice(TRIGGER.length + 1).trim()
    } else if (text.startsWith(TRIGGER)) {
      query = text.slice(TRIGGER.length).trim()
    } else {
      // Not triggered
      return
    }
    
    if (!query) return
    
    // Handle commands
    if (query.startsWith("/")) {
      await this.handleCommand(chatId, query)
      return
    }
    
    // Rate limiting
    if (!this.checkRateLimit(phoneNumber)) {
      console.log(`Rate limited: ${phoneNumber}`)
      return
    }
    
    console.log(`\n[QUERY] ${phoneNumber}: ${query}`)
    
    // Process the query
    await this.processQuery(chatId, phoneNumber, query)
  }
  
  private checkRateLimit(userId: string): boolean {
    const now = Date.now()
    const last = userLastMessage.get(userId) || 0
    if (now - last < RATE_LIMIT_SECONDS * 1000) {
      return false
    }
    userLastMessage.set(userId, now)
    return true
  }
  
  private async handleCommand(chatId: string, command: string): Promise<void> {
    const cmd = command.toLowerCase().trim()
    
    if (cmd === "/status") {
      const session = chatSessions.get(chatId)
      if (session) {
        const age = Math.round((Date.now() - session.createdAt.getTime()) / 1000 / 60)
        const lastAct = Math.round((Date.now() - session.lastActivity.getTime()) / 1000 / 60)
        const inputTokens = estimateTokens(session.inputChars)
        const outputTokens = estimateTokens(session.outputChars)
        const totalTokens = inputTokens + outputTokens
        // Claude context is ~200k tokens, show percentage
        const contextPercent = ((totalTokens / 200000) * 100).toFixed(2)
        await this.sendMessage(chatId,
          `Session status:\n` +
          `- Messages: ${session.messageCount}\n` +
          `- Age: ${age} min | Last active: ${lastAct} min ago\n` +
          `- Tokens (est): ~${totalTokens.toLocaleString()} (${contextPercent}% of 200k)\n` +
          `  Input: ~${inputTokens.toLocaleString()} | Output: ~${outputTokens.toLocaleString()}\n` +
          `Note: OpenCode auto-compacts when context fills`
        )
      } else {
        await this.sendMessage(chatId, "No active session for this chat.")
      }
      return
    }
    
    if (cmd === "/clear" || cmd === "/reset") {
      const session = chatSessions.get(chatId)
      if (session) {
        try {
          await session.client.disconnect()
        } catch {}
        chatSessions.delete(chatId)
        await this.sendMessage(chatId, "Session cleared. Next message will start a fresh session.")
      } else {
        await this.sendMessage(chatId, "No active session to clear.")
      }
      return
    }
    
    if (cmd === "/help") {
      await this.sendMessage(chatId,
        `OpenCode Chat Bridge\n\n` +
        `Commands:\n` +
        `- /status - Show session info\n` +
        `- /clear or /reset - Clear session\n` +
        `- /help - Show this help\n\n` +
        `Usage: ${TRIGGER} <your question>`
      )
      return
    }
    
    await this.sendMessage(chatId, `Unknown command: ${command}. Try /help`)
  }
  
  private async getOrCreateSession(chatId: string): Promise<ChatSession | null> {
    let session = chatSessions.get(chatId)
    if (!session) {
      // Get dedicated session directory for this chat
      const sessionDir = getSessionDir("whatsapp", chatId)
      ensureSessionDir(sessionDir)
      
      const client = new ACPClient({ cwd: sessionDir })
      
      try {
        await client.connect()
        await client.createSession()
        session = {
          client,
          createdAt: new Date(),
          messageCount: 0,
          lastActivity: new Date(),
          inputChars: 0,
          outputChars: 0,
        }
        chatSessions.set(chatId, session)
        console.log(`Created new ACP session for chat: ${chatId}`)
        console.log(`  Session directory: ${sessionDir}`)
      } catch (err) {
        console.error(`Failed to create ACP session:`, err)
        return null
      }
    }
    return session
  }
  
  private async processQuery(chatId: string, phoneNumber: string, query: string): Promise<void> {
    // Get or create session
    const session = await this.getOrCreateSession(chatId)
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
        // Send activity as a separate message
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
      console.log(`Received image: ${image.mimeType}`)
      await this.sendImage(chatId, image)
    }
    
    // Set up listeners
    client.on("activity", activityHandler)
    client.on("chunk", chunkHandler)
    client.on("update", updateHandler)
    client.on("image", imageHandler)
    
    try {
      // Send the prompt
      await client.prompt(query)
      
      // Check tool results for image file paths
      const imagePathRegex = /\[DOCLIBRARY_IMAGE\]([^\[]+)\[\/DOCLIBRARY_IMAGE\]/gi
      
      // Search in tool results
      const matches = toolResultsBuffer.matchAll(imagePathRegex)
      for (const match of matches) {
        const imagePath = match[1].trim()
        console.log(`[IMAGE] Found doclibrary image: ${imagePath}`)
        if (imagePath && fs.existsSync(imagePath)) {
          await this.sendImageFromFile(chatId, imagePath)
        }
      }
      
      // Also check response buffer
      const responseMatches = responseBuffer.matchAll(imagePathRegex)
      for (const match of responseMatches) {
        const imagePath = match[1].trim()
        console.log(`[IMAGE] Found doclibrary image in response: ${imagePath}`)
        if (imagePath && fs.existsSync(imagePath)) {
          await this.sendImageFromFile(chatId, imagePath)
        }
      }
      
      // Send the response
      if (responseBuffer.trim()) {
        session.outputChars += responseBuffer.trim().length
        await this.sendMessage(chatId, responseBuffer.trim())
      }
    } catch (err) {
      console.error("Error processing query:", err)
      await this.sendMessage(chatId, "Sorry, something went wrong processing your request.")
    } finally {
      // Clean up listeners
      client.off("activity", activityHandler)
      client.off("chunk", chunkHandler)
      client.off("update", updateHandler)
      client.off("image", imageHandler)
    }
  }
  
  private async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.sock) return
    
    try {
      // Prefix with bot name so user knows who's writing
      const prefixedText = `${BOT_NAME}: ${text}`
      await this.sock.sendMessage(chatId, { text: prefixedText })
    } catch (err) {
      console.error(`Failed to send message to ${chatId}:`, err)
    }
  }
  
  private async sendImage(chatId: string, image: ImageContent): Promise<void> {
    if (!this.sock) return
    
    try {
      const buffer = Buffer.from(image.data, "base64")
      await this.sock.sendMessage(chatId, {
        image: buffer,
        caption: image.alt || undefined,
      })
      console.log(`Sent image to ${chatId}`)
    } catch (err) {
      console.error(`Failed to send image to ${chatId}:`, err)
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
      console.log(`Sent image from file to ${chatId}: ${filePath}`)
    } catch (err) {
      console.error(`Failed to send image from file to ${chatId}:`, err)
    }
  }
  
  async stop(): Promise<void> {
    console.log("\nStopping WhatsApp connector...")
    
    // Disconnect all ACP sessions
    for (const [chatId, session] of chatSessions) {
      try {
        await session.client.disconnect()
        console.log(`Disconnected ACP session for chat: ${chatId}`)
      } catch {}
    }
    chatSessions.clear()
    
    // Close WhatsApp connection
    if (this.sock) {
      this.sock.end(undefined)
    }
    
    console.log("WhatsApp connector stopped.")
  }
}

// Main
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
