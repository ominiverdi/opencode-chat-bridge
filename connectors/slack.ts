#!/usr/bin/env bun
/**
 * Slack Connector for OpenCode Chat Bridge
 * 
 * Bridges Slack channels to OpenCode via ACP protocol.
 * Uses Socket Mode for real-time events without a public server.
 * 
 * Usage:
 *   bun connectors/slack.ts
 * 
 * Environment variables:
 *   SLACK_BOT_TOKEN - Bot User OAuth Token (starts with xoxb-)
 *   SLACK_APP_TOKEN - App-Level Token for Socket Mode (starts with xapp-)
 */

import fs from "fs"
import path from "path"
import { App } from "@slack/bolt"
import { ACPClient, type ActivityEvent } from "../src"
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

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const APP_TOKEN = process.env.SLACK_APP_TOKEN
const TRIGGER = process.env.SLACK_TRIGGER || "!oc"
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)
const RATE_LIMIT_SECONDS = 5

// =============================================================================
// Session Type
// =============================================================================

interface ChannelSession extends BaseSession {
  // Slack-specific fields can be added here if needed
}

// =============================================================================
// Slack Connector
// =============================================================================

class SlackConnector extends BaseConnector<ChannelSession> {
  private app: App | null = null

  constructor() {
    super({
      connector: "slack",
      trigger: TRIGGER,
      botName: "OpenCode Slack Bot",
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
      console.error("Error: SLACK_BOT_TOKEN not set")
      console.error("Get it from: api.slack.com/apps > Your App > OAuth & Permissions")
      process.exit(1)
    }
    if (!APP_TOKEN) {
      console.error("Error: SLACK_APP_TOKEN not set")
      console.error("Get it from: api.slack.com/apps > Your App > Basic Information > App-Level Tokens")
      process.exit(1)
    }

    this.logStartup()
    await this.cleanupSessions()

    // Create Slack app with Socket Mode
    this.app = new App({
      token: BOT_TOKEN,
      appToken: APP_TOKEN,
      socketMode: true,
    })

    // Handle app mentions (@bot)
    this.app.event("app_mention", async ({ event, say }) => {
      const userId = event.user || "unknown"
      const channel = event.channel || ""
      const text = event.text || ""

      if (!channel) return

      this.log(`[MENTION] ${userId} in ${channel}: ${text}`)

      // Extract query (remove the mention)
      const query = text.replace(/<@[A-Z0-9]+>/g, "").trim()
      if (!query) return

      // Rate limiting
      if (!this.checkRateLimit(userId)) return

      await this.processQuery(channel, userId, query, say)
    })

    // Handle messages with trigger prefix
    this.app.message(new RegExp(`^${TRIGGER}\\s+(.+)`, "i"), async ({ message, say }) => {
      // Type guard for message with text and user
      if (!("text" in message) || !message.text) return
      if (!("user" in message) || !message.user) return
      if (!("channel" in message) || !message.channel) return

      const userId = message.user
      const channel = message.channel
      const text = message.text

      this.log(`[MSG] ${userId} in ${channel}: ${text}`)

      // Extract query after trigger
      const match = text.match(new RegExp(`^${TRIGGER}\\s+(.+)`, "i"))
      if (!match) return
      const query = match[1].trim()

      // Handle commands
      if (query.startsWith("/")) {
        await this.handleCommand(channel, query, async (text) => { await say(text) })
        return
      }

      // Rate limiting
      if (!this.checkRateLimit(userId)) return

      await this.processQuery(channel, userId, query, say)
    })

    // Start the app
    await this.app.start()
    this.log("Started! Listening for messages...")
  }

  async stop(): Promise<void> {
    this.log("Stopping...")
    await this.disconnectAllSessions()

    if (this.app) {
      await this.app.stop()
    }

    this.log("Stopped.")
  }

  async sendMessage(channel: string, text: string): Promise<void> {
    // Note: For Slack, we use the `say` function from event context instead
    // This method is here for interface compliance but won't be called directly
    this.log(`sendMessage called for ${channel} - use say() instead`)
  }

  // ---------------------------------------------------------------------------
  // Slack-specific methods
  // ---------------------------------------------------------------------------

  private async processQuery(
    channel: string,
    user: string,
    query: string,
    say: (text: string) => Promise<unknown>
  ): Promise<void> {
    // Get or create session
    const session = await this.getOrCreateSession(channel, (client) =>
      this.createSession(client)
    )

    if (!session) {
      await say("Sorry, I couldn't connect to the AI service.")
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
        await say(`> ${activity.message}`)
      }
    }

    // Collect text chunks
    const chunkHandler = (text: string) => {
      responseBuffer += text
    }

    // Collect tool results (may contain images)
    const updateHandler = (update: any) => {
      if (update.type === "tool_result" && update.toolResult) {
        toolResultsBuffer += JSON.stringify(update.toolResult)
      }
    }

    // Set up listeners
    client.on("activity", activityHandler)
    client.on("chunk", chunkHandler)
    client.on("update", updateHandler)

    try {
      await client.prompt(query)

      // Process images from tool results
      const toolPaths = extractImagePaths(toolResultsBuffer)
      for (const imagePath of toolPaths) {
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from tool result: ${imagePath}`)
          await this.uploadImage(channel, imagePath)
        }
      }

      // Process images from response (model might echo paths)
      const responsePaths = extractImagePaths(responseBuffer)
      for (const imagePath of responsePaths) {
        // Skip if already uploaded from tool results
        if (toolPaths.includes(imagePath)) continue
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from response: ${imagePath}`)
          await this.uploadImage(channel, imagePath)
        }
      }

      // Clean response and send
      const cleanResponse = sanitizeServerPaths(removeImageMarkers(responseBuffer))
      if (cleanResponse) {
        session.outputChars += cleanResponse.length
        await say(cleanResponse)
      }
    } catch (err) {
      this.logError("Error processing query:", err)
      await say("Sorry, something went wrong processing your request.")
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

  private async uploadImage(channel: string, filePath: string): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        this.logError(`Image file not found: ${filePath}`)
        return
      }

      const fileName = path.basename(filePath)
      const fileBuffer = fs.readFileSync(filePath)

      await this.app!.client.files.uploadV2({
        channel_id: channel,
        file: fileBuffer,
        filename: fileName,
        title: fileName,
      })

      this.log(`Uploaded image to ${channel}: ${fileName}`)
    } catch (err) {
      this.logError(`Failed to upload image to ${channel}:`, err)
    }
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const connector = new SlackConnector()

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
