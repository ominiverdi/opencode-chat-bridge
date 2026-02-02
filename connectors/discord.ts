#!/usr/bin/env bun
/**
 * Discord Connector for OpenCode Chat Bridge
 * 
 * Bridges Discord channels to OpenCode via ACP protocol.
 * 
 * Usage:
 *   bun connectors/discord.ts
 * 
 * Environment variables:
 *   DISCORD_BOT_TOKEN - Bot token from Discord Developer Portal
 */

import fs from "fs"
import path from "path"
import {
  Client,
  GatewayIntentBits,
  Events,
  type Message,
  type TextBasedChannel,
  AttachmentBuilder,
} from "discord.js"
import { ACPClient, type ActivityEvent } from "../src"
import {
  BaseConnector,
  type BaseSession,
  extractImagePaths,
  removeImageMarkers,
} from "../src"

// =============================================================================
// Configuration
// =============================================================================

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
const TRIGGER = process.env.DISCORD_TRIGGER || "!oc"
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)
const RATE_LIMIT_SECONDS = 5

// =============================================================================
// Session Type
// =============================================================================

interface ChannelSession extends BaseSession {
  // Discord-specific fields can be added here if needed
}

// =============================================================================
// Discord Connector
// =============================================================================

class DiscordConnector extends BaseConnector<ChannelSession> {
  private client: Client | null = null

  constructor() {
    super({
      connector: "discord",
      trigger: TRIGGER,
      botName: "OpenCode Discord Bot",
      rateLimitSeconds: RATE_LIMIT_SECONDS,
      sessionRetentionDays: SESSION_RETENTION_DAYS,
    })
  }

  // ---------------------------------------------------------------------------
  // Abstract method implementations
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // Validate configuration
    if (!BOT_TOKEN) {
      console.error("Error: DISCORD_BOT_TOKEN not set")
      console.error("Get it from: discord.com/developers/applications > Your App > Bot > Token")
      process.exit(1)
    }

    this.logStartup()
    await this.cleanupSessions()

    // Create Discord client
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    })

    // Ready event
    this.client.once(Events.ClientReady, (c) => {
      this.log(`Logged in as ${c.user.tag}`)
      this.log("Listening for messages...")
    })

    // Message handler
    this.client.on(Events.MessageCreate, async (message) => {
      await this.handleMessage(message)
    })

    // Login
    await this.client.login(BOT_TOKEN)
  }

  async stop(): Promise<void> {
    this.log("Stopping...")
    await this.disconnectAllSessions()

    if (this.client) {
      this.client.destroy()
    }

    this.log("Stopped.")
  }

  async sendMessage(channel: string, text: string): Promise<void> {
    // Not used directly - we reply in context
    this.log(`sendMessage called for ${channel}`)
  }

  // ---------------------------------------------------------------------------
  // Discord-specific methods
  // ---------------------------------------------------------------------------

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return

    // Only handle text-based channels that support sending
    if (!message.channel.isSendable()) return

    const content = message.content.trim()
    const userId = message.author.id
    const channelId = message.channelId

    // Check for trigger prefix
    const triggerMatch = content.match(new RegExp(`^${TRIGGER}\\s+(.+)`, "is"))
    if (!triggerMatch) return

    const query = triggerMatch[1].trim()
    if (!query) return

    this.log(`[MSG] ${message.author.tag} in ${channelId}: ${content}`)

    // Handle commands
    if (query.startsWith("/")) {
      await this.handleCommand(channelId, query, async (text) => {
        await message.reply(text)
      })
      return
    }

    // Rate limiting
    if (!this.checkRateLimit(userId)) {
      await message.reply("Please wait a few seconds before sending another message.")
      return
    }

    await this.processQuery(message, query)
  }

  private async processQuery(message: Message, query: string): Promise<void> {
    const channelId = message.channelId

    // Get or create session
    const session = await this.getOrCreateSession(channelId, (client) =>
      this.createSession(client)
    )

    if (!session) {
      await message.reply("Sorry, I couldn't connect to the AI service.")
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

    // Get sendable channel
    const channel = message.channel
    if (!("send" in channel)) return

    // Activity events - show what the AI is doing
    const activityHandler = async (activity: ActivityEvent) => {
      if (activity.type === "tool_start" && activity.message !== lastActivityMessage) {
        lastActivityMessage = activity.message
        await channel.send(`> ${activity.message}`)
      }
    }

    // Collect text chunks
    const chunkHandler = (text: string) => {
      responseBuffer += text
    }

    // Collect tool results (may contain images)
    const updateHandler = (update: any) => {
      if (update.type === "tool_result" && update.content) {
        toolResultsBuffer += JSON.stringify(update.content)
      }
    }

    // Set up listeners
    client.on("activity", activityHandler)
    client.on("chunk", chunkHandler)
    client.on("update", updateHandler)

    try {
      // Show typing indicator
      if ("sendTyping" in channel) {
        await channel.sendTyping()
      }

      await client.prompt(query)

      // Process images from tool results
      const toolPaths = extractImagePaths(toolResultsBuffer)
      for (const imagePath of toolPaths) {
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from tool result: ${imagePath}`)
          await this.uploadImage(message, imagePath)
        }
      }

      // Process images from response (model might echo paths)
      const responsePaths = extractImagePaths(responseBuffer)
      for (const imagePath of responsePaths) {
        // Skip if already uploaded from tool results
        if (toolPaths.includes(imagePath)) continue
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from response: ${imagePath}`)
          await this.uploadImage(message, imagePath)
        }
      }

      // Clean response and send
      const cleanResponse = removeImageMarkers(responseBuffer)
      if (cleanResponse) {
        session.outputChars += cleanResponse.length
        
        // Discord has 2000 char limit, split if needed
        await this.sendLongMessage(message, cleanResponse)
      }
    } catch (err) {
      this.logError("Error processing query:", err)
      await message.reply("Sorry, something went wrong processing your request.")
    } finally {
      client.off("activity", activityHandler)
      client.off("chunk", chunkHandler)
      client.off("update", updateHandler)
    }
  }

  private createSession(client: ACPClient): ChannelSession {
    return {
      ...this.createBaseSession(client),
    }
  }

  private async uploadImage(message: Message, filePath: string): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        this.logError(`Image file not found: ${filePath}`)
        return
      }

      const channel = message.channel
      if (!("send" in channel)) return

      const fileName = path.basename(filePath)
      const attachment = new AttachmentBuilder(filePath, { name: fileName })

      await channel.send({ files: [attachment] })
      this.log(`Uploaded image: ${fileName}`)
    } catch (err) {
      this.logError(`Failed to upload image:`, err)
    }
  }

  private async sendLongMessage(message: Message, text: string): Promise<void> {
    const MAX_LENGTH = 2000
    
    if (text.length <= MAX_LENGTH) {
      await message.reply(text)
      return
    }

    const channel = message.channel
    if (!("send" in channel)) return

    // Split by paragraphs or newlines
    const chunks: string[] = []
    let current = ""

    for (const line of text.split("\n")) {
      if ((current + "\n" + line).length > MAX_LENGTH) {
        if (current) chunks.push(current)
        current = line
      } else {
        current = current ? current + "\n" + line : line
      }
    }
    if (current) chunks.push(current)

    // Send first chunk as reply, rest as follow-ups
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply(chunks[i])
      } else {
        await channel.send(chunks[i])
      }
    }
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const connector = new DiscordConnector()

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
