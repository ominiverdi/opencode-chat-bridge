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

// Configuration from environment
const HOMESERVER = process.env.MATRIX_HOMESERVER || "https://matrix.org"
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN
const USER_ID = process.env.MATRIX_USER_ID
const TRIGGER = process.env.MATRIX_TRIGGER || "!oc"

// Rate limiting: minimum seconds between responses per user
const RATE_LIMIT_SECONDS = 5
const userLastMessage = new Map<string, number>()

// Per-room ACP sessions with metadata
interface RoomSession {
  client: ACPClient
  createdAt: Date
  messageCount: number
  lastActivity: Date
}
const roomSessions = new Map<string, RoomSession>()

class MatrixConnector {
  private matrix: sdk.MatrixClient | null = null
  
  async start(): Promise<void> {
    // Validate configuration
    if (!ACCESS_TOKEN) {
      console.error("Error: MATRIX_ACCESS_TOKEN not set")
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
    console.log(`  Trigger: ${TRIGGER}`)
    
    // Create Matrix client
    this.matrix = sdk.createClient({
      baseUrl: HOMESERVER,
      accessToken: ACCESS_TOKEN,
      userId: USER_ID,
    })
    
    // Handle room messages
    this.matrix.on(sdk.RoomEvent.Timeline, this.handleRoomEvent.bind(this))
    
    // Handle invites - auto-join
    this.matrix.on(sdk.RoomMemberEvent.Membership, async (event, member) => {
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
    
    // Start syncing
    await this.matrix.startClient({ initialSyncLimit: 0 })
    console.log("Matrix connector started! Listening for messages...")
  }
  
  private async handleRoomEvent(
    event: sdk.MatrixEvent,
    room: sdk.Room | undefined,
    toStartOfTimeline: boolean | undefined
  ): Promise<void> {
    // Ignore old messages and non-text messages
    if (toStartOfTimeline) return
    if (event.getType() !== "m.room.message") return
    
    const content = event.getContent()
    if (content.msgtype !== "m.text") return
    
    // Ignore our own messages
    const sender = event.getSender()
    if (sender === USER_ID) return
    
    const body = content.body || ""
    const roomId = event.getRoomId()
    if (!roomId) return
    
    // Check trigger
    // Support: "!oc query" or "@botname: query" or direct mention
    let query = ""
    if (body.startsWith(TRIGGER + " ")) {
      query = body.slice(TRIGGER.length + 1).trim()
    } else if (body.includes(USER_ID!)) {
      // Mentioned by user ID
      query = body.replace(USER_ID!, "").trim()
    } else {
      // Not triggered
      return
    }
    
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
        await this.sendNotice(roomId, 
          `Session status:\n` +
          `- Messages: ${session.messageCount}\n` +
          `- Age: ${age} minutes\n` +
          `- Last activity: ${lastAct} minutes ago`
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
      const client = new ACPClient({ cwd: process.cwd() })
      
      try {
        await client.connect()
        await client.createSession()
        session = {
          client,
          createdAt: new Date(),
          messageCount: 0,
          lastActivity: new Date(),
        }
        roomSessions.set(roomId, session)
        console.log(`Created new ACP session for room: ${roomId}`)
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
    
    const client = session.client
    
    // Track response chunks
    let responseBuffer = ""
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
    
    // Handle images from tools (e.g., doclibrary page images)
    const imageHandler = async (image: ImageContent) => {
      console.log(`Received image: ${image.mimeType}`)
      await this.sendImage(roomId, image)
    }
    
    // Set up listeners
    client.on("activity", activityHandler)
    client.on("chunk", chunkHandler)
    client.on("image", imageHandler)
    
    try {
      // Send the prompt
      await client.prompt(query)
      
      // Check response for image file paths (workaround for ACP not passing images)
      const imageFileMatch = responseBuffer.match(/Image file: (.+\.png)/i)
      if (imageFileMatch) {
        const imagePath = imageFileMatch[1].trim()
        await this.sendImageFromFile(roomId, imagePath)
        // Remove the image file line from response
        responseBuffer = responseBuffer.replace(/Image file: .+\.png\n?/gi, "").trim()
      }
      
      // Send the final response
      if (responseBuffer.trim()) {
        await this.sendMessage(roomId, responseBuffer.trim())
      }
    } catch (err) {
      console.error("Error processing query:", err)
      await this.sendMessage(roomId, "Sorry, something went wrong processing your request.")
    } finally {
      // Clean up listeners
      client.off("activity", activityHandler)
      client.off("chunk", chunkHandler)
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
