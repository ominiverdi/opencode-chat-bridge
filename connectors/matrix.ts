#!/usr/bin/env bun
/**
 * Matrix Connector for OpenCode Chat Bridge
 * 
 * Bridges Matrix rooms to OpenCode via ACP protocol.
 * Uses matrix-bot-sdk with native Rust crypto for E2EE support.
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
const TRIGGER = config.trigger
const BOT_NAME = config.botName
const RATE_LIMIT_SECONDS = config.rateLimitSeconds
const FORMAT_HTML = config.matrix.formatHtml || false
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)

// Storage paths
const STORAGE_PATH = process.env.MATRIX_STORAGE_PATH || 
  path.join(os.homedir(), ".local", "share", "opencode-matrix-bot")
const STATE_STORAGE_PATH = path.join(STORAGE_PATH, "bot-state.json")
const CRYPTO_STORAGE_PATH = path.join(STORAGE_PATH, "crypto")
const TOKEN_FILE_PATH = path.join(STORAGE_PATH, "access_token")

// =============================================================================
// Session Type
// =============================================================================

interface RoomSession extends BaseSession {
  // Matrix-specific fields can be added here if needed
}

// =============================================================================
// Matrix Connector
// =============================================================================

class MatrixConnector extends BaseConnector<RoomSession> {
  private matrix: MatrixClient | null = null

  constructor() {
    super({
      connector: "matrix",
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
    await this.cleanupSessions()

    // Ensure storage directories exist
    fs.mkdirSync(STORAGE_PATH, { recursive: true })
    fs.mkdirSync(CRYPTO_STORAGE_PATH, { recursive: true })

    // Get access token (from config, saved file, or password login)
    let accessToken = await this.getOrCreateAccessToken()

    if (!accessToken) {
      console.error("Error: Could not obtain access token")
      process.exit(1)
    }

    // Set up logging (reduce noise)
    LogService.setLogger(new RichConsoleLogger())
    LogService.setLevel(LogLevel.INFO)
    LogService.muteModule("Metrics")

    // Create storage providers
    const stateStorage = new SimpleFsStorageProvider(STATE_STORAGE_PATH)
    const cryptoStorage = new RustSdkCryptoStorageProvider(CRYPTO_STORAGE_PATH)

    // Create the client with E2EE support
    this.matrix = new MatrixClient(HOMESERVER, accessToken, stateStorage, cryptoStorage)

    // Auto-join rooms when invited
    AutojoinRoomsMixin.setupOnClient(this.matrix)

    // Handle decryption failures
    this.matrix.on("room.failed_decryption", async (roomId: string, event: any, error: Error) => {
      this.log(`[CRYPTO] Failed to decrypt in ${roomId}: ${error.message}`)
    })

    // Handle messages (already decrypted by the SDK)
    this.matrix.on("room.message", this.handleRoomMessage.bind(this))

    // Start the client (this prepares crypto automatically)
    await this.matrix.start()
    
    // Note: "Unverified device" warning is cosmetic - E2EE still works
    // Cross-signing requires User Interactive Auth which bots can't easily do
    // To remove warning: verify bot's device manually from Element
    
    this.log("Started! Listening for messages...")
  }

  async stop(): Promise<void> {
    this.log("Stopping...")
    await this.disconnectAllSessions()

    if (this.matrix) {
      this.matrix.stop()
    }

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

  // ---------------------------------------------------------------------------
  // Matrix-specific: Authentication
  // ---------------------------------------------------------------------------

  private async getOrCreateAccessToken(): Promise<string | null> {
    // 1. Check config/env first
    if (ACCESS_TOKEN) {
      this.log("Using access token from config/env")
      return ACCESS_TOKEN
    }

    // 2. Check for saved token file
    if (fs.existsSync(TOKEN_FILE_PATH)) {
      const savedToken = fs.readFileSync(TOKEN_FILE_PATH, "utf-8").trim()
      if (savedToken) {
        this.log("Using saved access token")
        return savedToken
      }
    }

    // 3. Login with password and save token
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

      // Save token for future use
      fs.writeFileSync(TOKEN_FILE_PATH, accessToken)
      this.log(`Login successful! Token saved to ${TOKEN_FILE_PATH}`)

      return accessToken
    } catch (err: any) {
      this.logError("Password login failed:", err.message || err)
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Matrix-specific: Event handling
  // ---------------------------------------------------------------------------

  private async handleRoomMessage(roomId: string, event: any): Promise<void> {
    const message = new MessageEvent(event)

    // Ignore non-text messages
    if (message.messageType !== "m.text") return

    // Ignore our own messages
    const myUserId = await this.matrix!.getUserId()
    if (message.sender === myUserId) return

    const body = message.textBody.trim()
    if (!body) return

    this.log(`[MSG] ${message.sender}: ${body}`)

    // Check if this is a DM (direct message) room
    const members = await this.matrix!.getJoinedRoomMembers(roomId)
    const isDM = members.length === 2

    // Check trigger
    let query = ""
    if (body.startsWith(TRIGGER + " ")) {
      query = body.slice(TRIGGER.length + 1).trim()
    } else if (body.startsWith(TRIGGER)) {
      query = body.slice(TRIGGER.length).trim()
    } else if (body.includes(myUserId)) {
      query = body.replace(myUserId, "").trim()
    } else if (body.match(/^@?bot[:\s]/i)) {
      // Match "bot:" or "@bot:" at start
      query = body.replace(/^@?bot[:\s]*/i, "").trim()
    } else if (isDM) {
      // In DM rooms, respond to all messages without trigger
      query = body
    } else {
      return
    }

    // Clean up any remaining colons or @ from the query
    query = query.replace(/^[:\s]+/, "").trim()
    if (!query) return

    // Handle commands
    if (query.startsWith("/")) {
      const cmdName = query.slice(1).split(" ")[0].toLowerCase()
      
      // Bridge-local commands - handle without session
      const bridgeCommands = ["status", "clear", "reset", "help"]
      if (bridgeCommands.includes(cmdName)) {
        const existingSession = this.sessionManager.get(roomId)
        const openCodeCommands = existingSession?.client.availableCommands || []
        await this.handleCommand(roomId, query, async (text) => {
          await this.sendNotice(roomId, text)
        }, { openCodeCommands })
        return
      }
      
      // All other /commands -> forward to OpenCode (creates session if needed)
      // This supports /init, /compact, /review, and custom commands
      this.log(`[CMD] Forwarding to OpenCode: ${query}`)
      if (!this.checkRateLimit(message.sender)) return
      await this.processQuery(roomId, message.sender, query)
      return
    }

    // Rate limiting
    if (!this.checkRateLimit(message.sender)) return

    this.log(`[QUERY] ${roomId}: ${query}`)
    await this.processQuery(roomId, message.sender, query)
  }

  // ---------------------------------------------------------------------------
  // Matrix-specific: Query processing
  // ---------------------------------------------------------------------------

  private async processQuery(roomId: string, sender: string, query: string): Promise<void> {
    // Get or create session
    const session = await this.getOrCreateSession(roomId, (client) =>
      this.createSession(client)
    )

    if (!session) {
      await this.sendMessage(roomId, "Sorry, I couldn't connect to the AI service.")
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
    
    // Track what we've already sent to avoid duplication (by content hash)
    const sentToolOutputs = new Set<string>()

    // Activity events - show what the AI is doing
    const activityHandler = async (activity: ActivityEvent) => {
      if (activity.type === "tool_start" && activity.message !== lastActivityMessage) {
        lastActivityMessage = activity.message
        await this.sendNotice(roomId, `> ${activity.message}`)
      }
    }

    // Collect text chunks
    const chunkHandler = (text: string) => {
      responseBuffer += text
    }

    // Capture tool results for image markers AND stream outputs immediately
    const updateHandler = async (update: any) => {
      if (update.type === "tool_result" && update.toolResult) {
        toolResultsBuffer += update.toolResult
        
        // Only show results for tools in streamTools config
        const toolName = update.toolName || ""
        const streamTools = config.streamTools || ["bash"]
        const shouldShow = streamTools.some(t => toolName.includes(t))
        
        if (!shouldShow) {
          this.log(`[RESULT] Skipping ${toolName} result (not in streamTools)`)
          return
        }
        
        // Truncate very long outputs
        const maxLen = 2000
        const result = update.toolResult.length > maxLen 
          ? update.toolResult.slice(0, maxLen) + "\n... (truncated)"
          : update.toolResult
        
        // Skip empty results
        const trimmed = result.trim()
        if (!trimmed) {
          this.log(`[RESULT] Skipping empty tool result`)
          return
        }
        
        // Use content hash to prevent ANY duplicate content
        const contentHash = trimmed.slice(0, 100)
        if (sentToolOutputs.has(contentHash)) {
          this.log(`[RESULT] Skipping duplicate content`)
          return
        }
        
        sentToolOutputs.add(contentHash)
        try {
          await this.sendMessage(roomId, trimmed)
        } catch (err) {
          this.log(`[RESULT] Error sending: ${err}`)
        }
      }
      
      // Handle streaming partial output during tool execution
      // Only stream for tools in config.streamTools (default: ["bash"])
      if (update.type === "tool_output_delta" && update.partialOutput) {
        const toolName = update.toolName || ""
        const streamTools = config.streamTools || ["bash"]
        const shouldStream = streamTools.some(t => toolName.includes(t))
        
        if (shouldStream) {
          const output = update.partialOutput.trim()
          if (output) {
            const contentHash = output.slice(0, 100)
            if (!sentToolOutputs.has(contentHash)) {
              sentToolOutputs.add(contentHash)
              await this.sendMessage(roomId, output)
              this.log(`[STREAM] Sent ${toolName} output (${output.length} chars)`)
            }
          }
        }
      }
    }

    // Handle images from tools (e.g., doclibrary page images)
    const imageHandler = async (image: ImageContent) => {
      this.log(`Received image: ${image.mimeType}`)
      await this.sendImageFromBase64(roomId, image)
    }

    // Handle permission rejections
    const permissionHandler = async (event: { permission: string; path: string | null; message: string }) => {
      this.log(`[PERMISSION] Rejected: ${event.permission}${event.path ? ` (${event.path})` : ""}`)
      await this.sendNotice(roomId, `> ${event.message}`)
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
          await this.sendImageFromFile(roomId, imagePath)
          uploadedPaths.add(imagePath)
        }
      }

      // Process images from response (model might echo paths)
      const responsePaths = extractImagePaths(responseBuffer)
      for (const imagePath of responsePaths) {
        if (uploadedPaths.has(imagePath)) continue
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from response: ${imagePath}`)
          await this.sendImageFromFile(roomId, imagePath)
        }
      }

      // Clean response and send (tool outputs were already streamed)
      const cleanResponse = sanitizeServerPaths(removeImageMarkers(responseBuffer))
      
      if (cleanResponse) {
        // Check if the model's response is just repeating what we already sent
        const responsePreview = cleanResponse.slice(0, 100)
        const alreadySent = sentToolOutputs.has(responsePreview)
        
        if (!alreadySent) {
          session.outputChars += cleanResponse.length
          await this.sendMessage(roomId, cleanResponse)
        }
      }
    } catch (err) {
      this.logError("Error processing query:", err)
      await this.sendMessage(roomId, "Sorry, something went wrong processing your request.")
    } finally {
      client.off("activity", activityHandler)
      client.off("chunk", chunkHandler)
      client.off("update", updateHandler)
      client.off("image", imageHandler)
      client.off("permission_rejected", permissionHandler)
    }
  }

  private createSession(client: ACPClient): RoomSession {
    return {
      ...this.createBaseSession(client),
    }
  }

  // ---------------------------------------------------------------------------
  // Matrix-specific: Message sending
  // ---------------------------------------------------------------------------

  private async sendNotice(roomId: string, text: string): Promise<void> {
    try {
      await this.matrix!.sendNotice(roomId, text)
    } catch (err) {
      this.logError(`Failed to send notice to ${roomId}:`, err)
    }
  }

  private async sendImageFromBase64(roomId: string, image: ImageContent): Promise<void> {
    try {
      // Decode base64 and upload to Matrix
      const buffer = Buffer.from(image.data, "base64")
      const mxcUrl = await this.matrix!.uploadContent(buffer, image.mimeType, image.alt || "image.png")

      await this.matrix!.sendMessage(roomId, {
        msgtype: "m.image",
        body: image.alt || "Image",
        url: mxcUrl,
        info: {
          mimetype: image.mimeType,
          size: buffer.length,
        },
      })

      this.log(`Sent image to ${roomId}: ${mxcUrl}`)
    } catch (err) {
      this.logError(`Failed to send image to ${roomId}:`, err)
      await this.sendMessage(roomId, `[Image: ${image.alt || "Unable to display"}]`)
    }
  }

  private async sendImageFromFile(roomId: string, filePath: string): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        this.logError(`Image file not found: ${filePath}`)
        return
      }

      const buffer = fs.readFileSync(filePath)
      const fileName = path.basename(filePath)
      const mxcUrl = await this.matrix!.uploadContent(buffer, "image/png", fileName)

      await this.matrix!.sendMessage(roomId, {
        msgtype: "m.image",
        body: fileName,
        url: mxcUrl,
        info: {
          mimetype: "image/png",
          size: buffer.length,
        },
      })

      this.log(`Sent image from file to ${roomId}: ${mxcUrl}`)
    } catch (err) {
      this.logError(`Failed to send image from file to ${roomId}:`, err)
    }
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const connector = new MatrixConnector()

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
