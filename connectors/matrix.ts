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

import * as sdk from "matrix-js-sdk"
import { ACPClient, type ActivityEvent, type ImageContent } from "../src"
import { getConfig } from "../src/config"
import { getSessionDir, ensureSessionDir, cleanupOldSessions, getSessionStorageInfo, estimateTokens } from "../src/session-utils"

// Load configuration
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
const userLastMessage = new Map<string, number>()

// Per-room ACP sessions with metadata
interface RoomSession {
  client: ACPClient
  createdAt: Date
  messageCount: number
  lastActivity: Date
  inputChars: number    // Characters from user
  outputChars: number   // Characters from bot responses
}
const roomSessions = new Map<string, RoomSession>()

class MatrixConnector {
  private matrix: sdk.MatrixClient | null = null
  private currentAccessToken: string | null = null
  
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
    
    console.log("Starting Matrix connector...")
    console.log(`  Homeserver: ${HOMESERVER}`)
    console.log(`  User: ${USER_ID}`)
    console.log(`  Device ID: ${DEVICE_ID}`)
    console.log(`  Auth: ${PASSWORD ? "password" : "access token"}`)
    console.log(`  Trigger: ${TRIGGER}`)
    
    // Log session storage location
    const storageInfo = getSessionStorageInfo()
    console.log(`  Session storage: ${storageInfo.baseDir}`)
    console.log(`    (${storageInfo.source})`)
    
    // Cleanup old sessions
    console.log("Cleaning up old sessions...")
    const cleaned = cleanupOldSessions("matrix", SESSION_RETENTION_DAYS)
    if (cleaned > 0) {
      console.log(`  Cleaned up ${cleaned} session(s) older than ${SESSION_RETENTION_DAYS} days`)
    } else {
      console.log(`  No old sessions to clean`)
    }
    
    // Login and create client
    await this.login()
    
    // Handle room messages
    this.matrix!.on(sdk.RoomEvent.Timeline, this.handleRoomEvent.bind(this))
    
    // Handle sync state changes and token expiry
    this.matrix!.on(sdk.ClientEvent.Sync, async (state: string, prevState: string | null) => {
      if (state !== prevState) {
        console.log(`[SYNC] ${prevState} -> ${state}`)
      }
      
      // Handle token expiry - re-login if we have password
      if (state === "ERROR" && PASSWORD) {
        console.log("Sync error detected, attempting re-login...")
        await this.reconnect()
      }
    })
    
    // Handle invites - auto-join
    this.matrix!.on(sdk.RoomMemberEvent.Membership, async (event, member) => {
      if (member.membership === "invite" && member.userId === USER_ID) {
        console.log(`Invited to room: ${member.roomId}`)
        try {
          await this.matrix!.joinRoom(member.roomId)
          console.log(`Joined room: ${member.roomId}`)
        } catch (err) {
          console.error(`Failed to join room: ${member.roomId}`, err)
        }
      }
    })
    
    // Start syncing - get last 10 messages to initialize rooms properly
    await this.matrix!.startClient({ initialSyncLimit: 10 })
    console.log("Matrix connector started! Listening for messages...")
  }
  
  private async login(): Promise<void> {
    if (PASSWORD) {
      // Password-based login - generates fresh access token
      console.log("Logging in with password...")
      
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
        
        // Create the actual client with the new token
        this.matrix = sdk.createClient({
          baseUrl: HOMESERVER,
          accessToken: this.currentAccessToken!,
          userId: USER_ID!,
          deviceId: loginResponse.device_id,
        })
      } catch (err: any) {
        console.error("Password login failed:", err.message || err)
        throw err
      }
    } else {
      // Access token login (may expire)
      console.log("Using access token (may expire)...")
      this.currentAccessToken = ACCESS_TOKEN!
      
      this.matrix = sdk.createClient({
        baseUrl: HOMESERVER,
        accessToken: ACCESS_TOKEN,
        userId: USER_ID,
      })
    }
  }
  
  private async reconnect(): Promise<void> {
    if (!PASSWORD) {
      console.error("Cannot reconnect without password - token expired")
      return
    }
    
    console.log("Reconnecting...")
    
    try {
      // Stop current client
      if (this.matrix) {
        this.matrix.stopClient()
      }
      
      // Re-login
      await this.login()
      
      // Re-attach event handlers
      this.matrix!.on(sdk.RoomEvent.Timeline, this.handleRoomEvent.bind(this))
      this.matrix!.on(sdk.ClientEvent.Sync, async (state: string, prevState: string | null) => {
        if (state !== prevState) {
          console.log(`[SYNC] ${prevState} -> ${state}`)
        }
        if (state === "ERROR" && PASSWORD) {
          console.log("Sync error detected, attempting re-login...")
          await this.reconnect()
        }
      })
      this.matrix!.on(sdk.RoomMemberEvent.Membership, async (event, member) => {
        if (member.membership === "invite" && member.userId === USER_ID) {
          try {
            await this.matrix!.joinRoom(member.roomId)
            console.log(`Joined room: ${member.roomId}`)
          } catch (err) {
            console.error(`Failed to join room: ${member.roomId}`, err)
          }
        }
      })
      
      // Restart client
      await this.matrix!.startClient({ initialSyncLimit: 10 })
      console.log("Reconnected successfully!")
    } catch (err) {
      console.error("Reconnection failed:", err)
      // Wait and try again
      setTimeout(() => this.reconnect(), 30000)
    }
  }
  
  private async handleRoomEvent(
    event: sdk.MatrixEvent,
    room: sdk.Room | undefined,
    toStartOfTimeline: boolean | undefined
  ): Promise<void> {
    // Log all timeline events for debugging
    const eventType = event.getType()
    console.log(`[EVENT] type=${eventType} room=${room?.name} toStart=${toStartOfTimeline}`)
    
    // Ignore old messages and non-text messages
    if (toStartOfTimeline) return
    if (eventType !== "m.room.message") return
    
    const content = event.getContent()
    if (content.msgtype !== "m.text") return
    
    // Ignore our own messages
    const sender = event.getSender()
    if (sender === USER_ID) return
    
    const body = (content.body || "").trim()  // Trim whitespace
    const roomId = event.getRoomId()
    if (!roomId) return
    
    // Log the message
    console.log(`[MSG] ${sender}: ${body}`)
    
    // Check trigger
    // Support: "!oc query" or "@bot: query" or full mention
    let query = ""
    if (body.startsWith(TRIGGER + " ")) {
      query = body.slice(TRIGGER.length + 1).trim()
    } else if (body.startsWith(TRIGGER)) {
      // Handle "!oc" without space (e.g., "!ochello")
      query = body.slice(TRIGGER.length).trim()
    } else if (body.includes(USER_ID!)) {
      // Mentioned by full user ID (@bot_ominiverdi:matrix.org)
      query = body.replace(USER_ID!, "").trim()
    } else if (body.match(/^@bot[:\s]/i)) {
      // Mentioned by short name (@bot: or @bot )
      query = body.replace(/^@bot[:\s]*/i, "").trim()
    } else {
      // Not triggered
      return
    }
    
    // Clean up any remaining colons or @ from the query
    query = query.replace(/^[:\s]+/, "").trim()
    
    if (!query) return
    
    // Handle session management commands
    if (query.startsWith("/")) {
      await this.handleCommand(roomId, sender!, query)
      return
    }
    
    // Rate limiting
    if (!this.checkRateLimit(sender!)) {
      console.log(`Rate limited: ${sender}`)
      return
    }
    
    console.log(`\n[${room?.name || roomId}] ${sender}: ${query}`)
    
    // Process the query
    await this.processQuery(roomId, sender!, query)
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
  
  private async handleCommand(roomId: string, sender: string, command: string): Promise<void> {
    const cmd = command.toLowerCase().trim()
    
    if (cmd === "/status") {
      const session = roomSessions.get(roomId)
      if (session) {
        const age = Math.round((Date.now() - session.createdAt.getTime()) / 1000 / 60)
        const lastAct = Math.round((Date.now() - session.lastActivity.getTime()) / 1000 / 60)
        const inputTokens = estimateTokens(session.inputChars)
        const outputTokens = estimateTokens(session.outputChars)
        const totalTokens = inputTokens + outputTokens
        // Claude context is ~200k tokens, show percentage
        const contextPercent = ((totalTokens / 200000) * 100).toFixed(2)
        await this.sendNotice(roomId, 
          `Session status:\n` +
          `- Messages: ${session.messageCount}\n` +
          `- Age: ${age} min | Last active: ${lastAct} min ago\n` +
          `- Tokens (est): ~${totalTokens.toLocaleString()} (${contextPercent}% of 200k)\n` +
          `  Input: ~${inputTokens.toLocaleString()} | Output: ~${outputTokens.toLocaleString()}\n` +
          `Note: OpenCode auto-compacts when context fills`
        )
      } else {
        await this.sendNotice(roomId, "No active session for this room.")
      }
      return
    }
    
    if (cmd === "/clear" || cmd === "/reset") {
      const session = roomSessions.get(roomId)
      if (session) {
        try {
          await session.client.disconnect()
        } catch {}
        roomSessions.delete(roomId)
        await this.sendNotice(roomId, "Session cleared. Next message will start a fresh session.")
      } else {
        await this.sendNotice(roomId, "No active session to clear.")
      }
      return
    }
    
    if (cmd === "/help") {
      await this.sendNotice(roomId,
        `Available commands:\n` +
        `- /status - Show session info\n` +
        `- /clear or /reset - Clear session history\n` +
        `- /help - Show this help`
      )
      return
    }
    
    await this.sendNotice(roomId, `Unknown command: ${command}. Try /help`)
  }
  
  private async getOrCreateSession(roomId: string): Promise<RoomSession | null> {
    let session = roomSessions.get(roomId)
    if (!session) {
      // Get dedicated session directory for this room
      const sessionDir = getSessionDir("matrix", roomId)
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
        roomSessions.set(roomId, session)
        console.log(`Created new ACP session for room: ${roomId}`)
        console.log(`  Session directory: ${sessionDir}`)
      } catch (err) {
        console.error(`Failed to create ACP session:`, err)
        return null
      }
    }
    return session
  }
  
  private async processQuery(roomId: string, sender: string, query: string): Promise<void> {
    // Get or create session for this room
    const session = await this.getOrCreateSession(roomId)
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
    let toolResultsBuffer = ""  // Capture tool results separately for image markers
    let lastActivityMessage = ""
    
    // Activity events - show what the AI is doing
    const activityHandler = async (activity: ActivityEvent) => {
      if (activity.type === "tool_start" && activity.message !== lastActivityMessage) {
        lastActivityMessage = activity.message
        // Send activity as a notice (less prominent in most clients)
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
      console.log(`Received image: ${image.mimeType}`)
      await this.sendImage(roomId, image)
    }
    
    // Set up listeners
    client.on("activity", activityHandler)
    client.on("chunk", chunkHandler)
    client.on("update", updateHandler)
    client.on("image", imageHandler)
    
    try {
      // Send the prompt
      await client.prompt(query)
      
      // Check tool results for image file paths using doclibrary marker
      // Format: [DOCLIBRARY_IMAGE]/path/to/file.png[/DOCLIBRARY_IMAGE]
      const fs = require("fs")
      const imagePathRegex = /\[DOCLIBRARY_IMAGE\]([^\[]+)\[\/DOCLIBRARY_IMAGE\]/gi
      
      // Search in tool results (where doclibrary returns the markers)
      const matches = toolResultsBuffer.matchAll(imagePathRegex)
      for (const match of matches) {
        const imagePath = match[1].trim()
        console.log(`[IMAGE] Found doclibrary image in tool result: ${imagePath}`)
        if (imagePath && fs.existsSync(imagePath)) {
          await this.sendImageFromFile(roomId, imagePath)
        }
      }
      
      // Also check response buffer in case model echoes the path
      const responseMatches = responseBuffer.matchAll(imagePathRegex)
      for (const match of responseMatches) {
        const imagePath = match[1].trim()
        console.log(`[IMAGE] Found doclibrary image in response: ${imagePath}`)
        if (imagePath && fs.existsSync(imagePath)) {
          await this.sendImageFromFile(roomId, imagePath)
        }
      }
      
      // Send the final response
      if (responseBuffer.trim()) {
        session.outputChars += responseBuffer.trim().length
        await this.sendMessage(roomId, responseBuffer.trim())
      }
    } catch (err) {
      console.error("Error processing query:", err)
      await this.sendMessage(roomId, "Sorry, something went wrong processing your request.")
    } finally {
      // Clean up listeners
      client.off("activity", activityHandler)
      client.off("chunk", chunkHandler)
      client.off("update", updateHandler)
      client.off("image", imageHandler)
    }
  }
  
  private async sendMessage(roomId: string, text: string): Promise<void> {
    try {
      await this.matrix!.sendMessage(roomId, {
        msgtype: sdk.MsgType.Text,
        body: text,
      })
    } catch (err) {
      console.error(`Failed to send message to ${roomId}:`, err)
    }
  }
  
  private async sendNotice(roomId: string, text: string): Promise<void> {
    try {
      await this.matrix!.sendMessage(roomId, {
        msgtype: sdk.MsgType.Notice,
        body: text,
      })
    } catch (err) {
      console.error(`Failed to send notice to ${roomId}:`, err)
    }
  }
  
  private async sendImage(roomId: string, image: ImageContent): Promise<void> {
    try {
      // Decode base64 and upload to Matrix
      const buffer = Buffer.from(image.data, "base64")
      
      // Upload the image
      const uploadResponse = await this.matrix!.uploadContent(buffer, {
        type: image.mimeType,
        name: image.alt || "image.png",
      })
      
      const mxcUrl = uploadResponse.content_uri
      
      // Send as image message
      await this.matrix!.sendMessage(roomId, {
        msgtype: sdk.MsgType.Image,
        body: image.alt || "Image",
        url: mxcUrl,
        info: {
          mimetype: image.mimeType,
          size: buffer.length,
        },
      })
      
      console.log(`Sent image to ${roomId}: ${mxcUrl}`)
    } catch (err) {
      console.error(`Failed to send image to ${roomId}:`, err)
      // Fallback: send a message about the image
      await this.sendMessage(roomId, `[Image: ${image.alt || "Unable to display"}]`)
    }
  }
  
  private async sendImageFromFile(roomId: string, filePath: string): Promise<void> {
    try {
      const fs = await import("fs")
      const path = await import("path")
      
      if (!fs.existsSync(filePath)) {
        console.error(`Image file not found: ${filePath}`)
        return
      }
      
      const buffer = fs.readFileSync(filePath)
      const fileName = path.basename(filePath)
      
      // Upload the image
      const uploadResponse = await this.matrix!.uploadContent(buffer, {
        type: "image/png",
        name: fileName,
      })
      
      const mxcUrl = uploadResponse.content_uri
      
      // Send as image message
      await this.matrix!.sendMessage(roomId, {
        msgtype: sdk.MsgType.Image,
        body: fileName,
        url: mxcUrl,
        info: {
          mimetype: "image/png",
          size: buffer.length,
        },
      })
      
      console.log(`Sent image from file to ${roomId}: ${mxcUrl}`)
    } catch (err) {
      console.error(`Failed to send image from file to ${roomId}:`, err)
    }
  }
  
  async stop(): Promise<void> {
    console.log("\nStopping Matrix connector...")
    
    // Disconnect all ACP sessions
    for (const [roomId, session] of roomSessions) {
      try {
        await session.client.disconnect()
        console.log(`Disconnected ACP session for room: ${roomId}`)
      } catch {}
    }
    roomSessions.clear()
    
    // Stop Matrix client
    if (this.matrix) {
      this.matrix.stopClient()
    }
    
    console.log("Matrix connector stopped.")
  }
}

// Main
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
