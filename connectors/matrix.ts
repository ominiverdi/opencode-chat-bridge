#!/usr/bin/env bun
/**
 * Matrix Connector for OpenCode Chat Bridge
 * 
 * Bridges Matrix rooms to OpenCode via ACP protocol.
 * Shows activity logs (tool calls) and handles images from document library.
 * 
 * Usage:
 *   bun connectors/matrix.ts
 * 
 * Environment variables (see .env.example):
 *   MATRIX_HOMESERVER - Matrix server URL (e.g., https://matrix.org)
 *   MATRIX_ACCESS_TOKEN - Bot access token
 *   MATRIX_USER_ID - Bot user ID (e.g., @mybot:matrix.org)
 *   MATRIX_TRIGGER - Message prefix to trigger bot (default: !oc)
 */

import fs from "fs"
import path from "path"
import os from "os"

// E2EE: IndexedDB polyfill for Node.js/Bun (must be before crypto import)
import "fake-indexeddb/auto"

import * as sdk from "matrix-js-sdk"
import { ACPClient, type ActivityEvent, type ImageContent } from "../src"
import { getConfig } from "../src/config"
import {
  BaseConnector,
  type BaseSession,
  extractImagePaths,
  removeImageMarkers,
  sanitizeServerPaths,
} from "../src"

// E2EE: Import Rust crypto (after IndexedDB polyfill)
import "@matrix-org/matrix-sdk-crypto-wasm"

// =============================================================================
// Configuration
// =============================================================================

const config = getConfig()
const HOMESERVER = config.matrix.homeserver
const ACCESS_TOKEN = config.matrix.accessToken || process.env.MATRIX_ACCESS_TOKEN
const PASSWORD = config.matrix.password || process.env.MATRIX_PASSWORD
const USER_ID = config.matrix.userId || process.env.MATRIX_USER_ID
const DEVICE_ID = config.matrix.deviceId || process.env.MATRIX_DEVICE_ID || "OPENCODE_BRIDGE"
const TRIGGER = config.trigger
const BOT_NAME = config.botName
const RATE_LIMIT_SECONDS = config.rateLimitSeconds
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)

// E2EE: Crypto store path for persistent encryption keys
const CRYPTO_STORE_PATH = process.env.MATRIX_CRYPTO_STORE || 
  path.join(os.homedir(), ".local", "share", "opencode-matrix-crypto")

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
  private matrix: sdk.MatrixClient | null = null
  private currentAccessToken: string | null = null

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
    if (!PASSWORD && !ACCESS_TOKEN) {
      console.error("Error: Either MATRIX_PASSWORD or MATRIX_ACCESS_TOKEN must be set")
      console.error("Password-based login is recommended (tokens don't expire)")
      console.error("Create a .env file with your Matrix credentials")
      process.exit(1)
    }
    if (!USER_ID) {
      console.error("Error: MATRIX_USER_ID not set")
      process.exit(1)
    }

    this.log("Starting...")
    console.log(`  Homeserver: ${HOMESERVER}`)
    console.log(`  User: ${USER_ID}`)
    console.log(`  Device ID: ${DEVICE_ID}`)
    console.log(`  Auth: ${PASSWORD ? "password" : "access token"}`)
    console.log(`  E2EE: enabled (store: ${CRYPTO_STORE_PATH})`)
    this.logStartup()
    await this.cleanupSessions()

    // Ensure crypto store directory exists
    if (!fs.existsSync(CRYPTO_STORE_PATH)) {
      fs.mkdirSync(CRYPTO_STORE_PATH, { recursive: true })
    }

    // Login and create client
    await this.login()

    // Handle room messages (including decrypted ones)
    this.matrix!.on(sdk.RoomEvent.Timeline, this.handleRoomEvent.bind(this))
    
    // Handle decrypted messages - re-process after decryption
    this.matrix!.on(sdk.MatrixEventEvent.Decrypted, async (event) => {
      const room = this.matrix!.getRoom(event.getRoomId()!)
      await this.handleRoomEvent(event, room ?? undefined, false)
    })

    // Handle sync state changes and token expiry
    this.matrix!.on(sdk.ClientEvent.Sync, async (state: string, prevState: string | null) => {
      if (state !== prevState) {
        this.log(`[SYNC] ${prevState} -> ${state}`)
      }

      // Handle token expiry - re-login if we have password
      if (state === "ERROR" && PASSWORD) {
        this.log("Sync error detected, attempting re-login...")
        await this.reconnect()
      }
    })

    // Handle invites - auto-join
    this.matrix!.on(sdk.RoomMemberEvent.Membership, async (event, member) => {
      if (member.membership === "invite" && member.userId === USER_ID) {
        this.log(`Invited to room: ${member.roomId}`)
        try {
          await this.matrix!.joinRoom(member.roomId)
          this.log(`Joined room: ${member.roomId}`)
        } catch (err) {
          this.logError(`Failed to join room: ${member.roomId}`, err)
        }
      }
    })

    // Start syncing - get last 10 messages to initialize rooms properly
    await this.matrix!.startClient({ initialSyncLimit: 10 })
    this.log("Started! Listening for messages...")
  }

  async stop(): Promise<void> {
    this.log("Stopping...")
    await this.disconnectAllSessions()

    if (this.matrix) {
      this.matrix.stopClient()
    }

    this.log("Stopped.")
  }

  async sendMessage(roomId: string, text: string): Promise<void> {
    try {
      await this.matrix!.sendMessage(roomId, {
        msgtype: sdk.MsgType.Text,
        body: text,
      })
    } catch (err) {
      this.logError(`Failed to send message to ${roomId}:`, err)
    }
  }

  // ---------------------------------------------------------------------------
  // Matrix-specific: Authentication
  // ---------------------------------------------------------------------------

  private async login(): Promise<void> {
    if (PASSWORD) {
      // Password-based login - generates fresh access token
      this.log("Logging in with password...")

      // Create temporary client for login
      const tempClient = sdk.createClient({ baseUrl: HOMESERVER })

      try {
        // Extract username from full user ID (@user:server.org -> user)
        const username = USER_ID!.split(":")[0].replace("@", "")

        // Try login with localpart first, then full user ID if that fails
        let loginResponse
        try {
          loginResponse = await tempClient.login("m.login.password", {
            user: username,
            password: PASSWORD,
            device_id: DEVICE_ID,
            initial_device_display_name: "OpenCode Chat Bridge",
          })
        } catch (err: any) {
          if (err.httpStatus === 403) {
            console.log("  Trying with full user ID...")
            loginResponse = await tempClient.login("m.login.password", {
              user: USER_ID!,
              password: PASSWORD,
              device_id: DEVICE_ID,
              initial_device_display_name: "OpenCode Chat Bridge",
            })
          } else {
            throw err
          }
        }

        this.currentAccessToken = loginResponse.access_token
        console.log(`  Login successful! Device: ${loginResponse.device_id}`)

        // Create the actual client with the new token and crypto support
        this.matrix = sdk.createClient({
          baseUrl: HOMESERVER,
          accessToken: this.currentAccessToken!,
          userId: USER_ID!,
          deviceId: loginResponse.device_id,
        })

        // Initialize E2EE with Rust crypto
        await this.initializeCrypto()
      } catch (err: any) {
        this.logError("Password login failed:", err.message || err)
        throw err
      }
    } else {
      // Access token login (may expire)
      this.log("Using access token (may expire)...")
      this.currentAccessToken = ACCESS_TOKEN!

      this.matrix = sdk.createClient({
        baseUrl: HOMESERVER,
        accessToken: ACCESS_TOKEN,
        userId: USER_ID,
        deviceId: DEVICE_ID,
      })

      // Initialize E2EE with Rust crypto
      await this.initializeCrypto()
    }
  }

  private async initializeCrypto(): Promise<void> {
    if (!this.matrix) return

    try {
      this.log("Initializing E2EE (Rust crypto)...")
      
      // Initialize Rust crypto with persistent store
      await this.matrix.initRustCrypto({
        storePath: CRYPTO_STORE_PATH,
        storePassphrase: "opencode-matrix-bridge",
      })

      // Set up crypto event handlers
      this.matrix.on(sdk.CryptoEvent.VerificationRequestReceived, (request) => {
        this.log(`Verification request from: ${request.otherUserId}`)
        // Auto-accept verification for simplicity (can be made interactive)
      })

      this.log("E2EE initialized successfully!")
    } catch (err: any) {
      this.logError("Failed to initialize E2EE:", err.message || err)
      this.log("Continuing without E2EE support - encrypted messages won't be readable")
    }
  }

  private async reconnect(): Promise<void> {
    if (!PASSWORD) {
      this.logError("Cannot reconnect without password - token expired")
      return
    }

    this.log("Reconnecting...")

    try {
      // Stop current client
      if (this.matrix) {
        this.matrix.stopClient()
      }

      // Re-login
      await this.login()

      // Re-attach event handlers
      this.matrix!.on(sdk.RoomEvent.Timeline, this.handleRoomEvent.bind(this))
      this.matrix!.on(sdk.MatrixEventEvent.Decrypted, async (event) => {
        const room = this.matrix!.getRoom(event.getRoomId()!)
        await this.handleRoomEvent(event, room ?? undefined, false)
      })
      this.matrix!.on(sdk.ClientEvent.Sync, async (state: string, prevState: string | null) => {
        if (state !== prevState) {
          this.log(`[SYNC] ${prevState} -> ${state}`)
        }
        if (state === "ERROR" && PASSWORD) {
          this.log("Sync error detected, attempting re-login...")
          await this.reconnect()
        }
      })
      this.matrix!.on(sdk.RoomMemberEvent.Membership, async (event, member) => {
        if (member.membership === "invite" && member.userId === USER_ID) {
          try {
            await this.matrix!.joinRoom(member.roomId)
            this.log(`Joined room: ${member.roomId}`)
          } catch (err) {
            this.logError(`Failed to join room: ${member.roomId}`, err)
          }
        }
      })

      // Restart client
      await this.matrix!.startClient({ initialSyncLimit: 10 })
      this.log("Reconnected successfully!")
    } catch (err) {
      this.logError("Reconnection failed:", err)
      // Wait and try again
      setTimeout(() => this.reconnect(), 30000)
    }
  }

  // ---------------------------------------------------------------------------
  // Matrix-specific: Event handling
  // ---------------------------------------------------------------------------

  private async handleRoomEvent(
    event: sdk.MatrixEvent,
    room: sdk.Room | undefined,
    toStartOfTimeline: boolean | undefined
  ): Promise<void> {
    // Ignore old messages
    if (toStartOfTimeline) return
    
    // Handle encrypted messages - wait for decryption
    if (event.isEncrypted()) {
      // Check if already decrypted
      if (event.isDecryptionFailure()) {
        this.log(`[CRYPTO] Failed to decrypt message from ${event.getSender()}`)
        return
      }
      // If still being decrypted, the event will be re-emitted when done
      if (event.isBeingDecrypted()) {
        return
      }
    }
    
    if (event.getType() !== "m.room.message") return

    const content = event.getContent()
    if (content.msgtype !== "m.text") return

    // Ignore our own messages
    const sender = event.getSender()
    if (sender === USER_ID) return

    const body = (content.body || "").trim()
    const roomId = event.getRoomId()
    if (!roomId) return

    this.log(`[MSG] ${sender}: ${body}`)

    // Check if this is a DM (direct message) room - use the room parameter passed to handler
    const isDM = room && room.getJoinedMemberCount() === 2

    // Check trigger
    let query = ""
    if (body.startsWith(TRIGGER + " ")) {
      query = body.slice(TRIGGER.length + 1).trim()
    } else if (body.startsWith(TRIGGER)) {
      query = body.slice(TRIGGER.length).trim()
    } else if (body.includes(USER_ID!)) {
      query = body.replace(USER_ID!, "").trim()
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
      await this.handleCommand(roomId, query, async (text) => {
        await this.sendNotice(roomId, text)
      })
      return
    }

    // Rate limiting
    if (!this.checkRateLimit(sender!)) return

    this.log(`[${room?.name || roomId}] ${sender}: ${query}`)
    await this.processQuery(roomId, sender!, query)
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

    // Capture tool results for image markers
    const updateHandler = (update: any) => {
      if (update.type === "tool_result" && update.toolResult) {
        toolResultsBuffer += update.toolResult
      }
    }

    // Handle images from tools (e.g., doclibrary page images)
    const imageHandler = async (image: ImageContent) => {
      this.log(`Received image: ${image.mimeType}`)
      await this.sendImageFromBase64(roomId, image)
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

      // Clean response and send
      const cleanResponse = sanitizeServerPaths(removeImageMarkers(responseBuffer))
      if (cleanResponse) {
        session.outputChars += cleanResponse.length
        await this.sendMessage(roomId, cleanResponse)
      }
    } catch (err) {
      this.logError("Error processing query:", err)
      await this.sendMessage(roomId, "Sorry, something went wrong processing your request.")
    } finally {
      client.off("activity", activityHandler)
      client.off("chunk", chunkHandler)
      client.off("update", updateHandler)
      client.off("image", imageHandler)
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
      await this.matrix!.sendMessage(roomId, {
        msgtype: sdk.MsgType.Notice,
        body: text,
      })
    } catch (err) {
      this.logError(`Failed to send notice to ${roomId}:`, err)
    }
  }

  private async sendImageFromBase64(roomId: string, image: ImageContent): Promise<void> {
    try {
      // Decode base64 and upload to Matrix
      const buffer = Buffer.from(image.data, "base64")

      const uploadResponse = await this.matrix!.uploadContent(buffer, {
        type: image.mimeType,
        name: image.alt || "image.png",
      })

      const mxcUrl = uploadResponse.content_uri

      await this.matrix!.sendMessage(roomId, {
        msgtype: sdk.MsgType.Image,
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

      const uploadResponse = await this.matrix!.uploadContent(buffer, {
        type: "image/png",
        name: fileName,
      })

      const mxcUrl = uploadResponse.content_uri

      await this.matrix!.sendMessage(roomId, {
        msgtype: sdk.MsgType.Image,
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
