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

import { App } from "@slack/bolt"
import { ACPClient, type ActivityEvent } from "../src"

// Configuration from environment
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const APP_TOKEN = process.env.SLACK_APP_TOKEN
const TRIGGER = process.env.SLACK_TRIGGER || "!oc"

// Rate limiting
const RATE_LIMIT_SECONDS = 5
const userLastMessage = new Map<string, number>()

// Per-channel ACP sessions
interface ChannelSession {
  client: ACPClient
  createdAt: Date
  messageCount: number
  lastActivity: Date
}
const channelSessions = new Map<string, ChannelSession>()

class SlackConnector {
  private app: App | null = null

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

    console.log("Starting Slack connector...")
    console.log(`  Trigger: ${TRIGGER}`)

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
      
      console.log(`[MENTION] ${userId} in ${channel}: ${text}`)
      
      // Extract query (remove the mention)
      const query = text.replace(/<@[A-Z0-9]+>/g, "").trim()
      if (!query) return

      // Rate limiting
      if (!this.checkRateLimit(userId)) {
        console.log(`Rate limited: ${userId}`)
        return
      }

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
      
      console.log(`[MSG] ${userId} in ${channel}: ${text}`)

      // Extract query after trigger
      const match = text.match(new RegExp(`^${TRIGGER}\\s+(.+)`, "i"))
      if (!match) return
      const query = match[1].trim()

      // Handle commands
      if (query.startsWith("/")) {
        await this.handleCommand(channel, userId, query, say)
        return
      }

      // Rate limiting
      if (!this.checkRateLimit(userId)) {
        console.log(`Rate limited: ${userId}`)
        return
      }

      await this.processQuery(channel, userId, query, say)
    })

    // Start the app
    await this.app.start()
    console.log("Slack connector started! Listening for messages...")
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

  private async handleCommand(
    channel: string,
    user: string,
    command: string,
    say: (text: string) => Promise<unknown>
  ): Promise<void> {
    const cmd = command.toLowerCase().trim()

    if (cmd === "/status") {
      const session = channelSessions.get(channel)
      if (session) {
        const age = Math.round((Date.now() - session.createdAt.getTime()) / 1000 / 60)
        const lastAct = Math.round((Date.now() - session.lastActivity.getTime()) / 1000 / 60)
        await say(
          `Session status:\n` +
          `- Messages: ${session.messageCount}\n` +
          `- Age: ${age} minutes\n` +
          `- Last activity: ${lastAct} minutes ago`
        )
      } else {
        await say("No active session for this channel.")
      }
      return
    }

    if (cmd === "/clear" || cmd === "/reset") {
      const session = channelSessions.get(channel)
      if (session) {
        try {
          await session.client.disconnect()
        } catch {}
        channelSessions.delete(channel)
        await say("Session cleared. Next message will start a fresh session.")
      } else {
        await say("No active session to clear.")
      }
      return
    }

    if (cmd === "/help") {
      await say(
        `Available commands:\n` +
        `- /status - Show session info\n` +
        `- /clear or /reset - Clear session history\n` +
        `- /help - Show this help\n\n` +
        `Or just type: ${TRIGGER} your question here`
      )
      return
    }

    await say(`Unknown command: ${command}. Try /help`)
  }

  private async getOrCreateSession(channel: string): Promise<ChannelSession | null> {
    let session = channelSessions.get(channel)
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
        channelSessions.set(channel, session)
        console.log(`Created new ACP session for channel: ${channel}`)
      } catch (err) {
        console.error(`Failed to create ACP session:`, err)
        return null
      }
    }
    return session
  }

  private async processQuery(
    channel: string,
    user: string,
    query: string,
    say: (text: string) => Promise<unknown>
  ): Promise<void> {
    // Get or create session for this channel
    const session = await this.getOrCreateSession(channel)
    if (!session) {
      await say("Sorry, I couldn't connect to the AI service.")
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
        // Send activity as a message (Slack doesn't have "notice" type)
        await say(`> ${activity.message}`)
      }
    }

    // Collect text chunks
    const chunkHandler = (text: string) => {
      responseBuffer += text
    }

    // Set up listeners
    client.on("activity", activityHandler)
    client.on("chunk", chunkHandler)

    try {
      // Send the prompt
      await client.prompt(query)

      // Debug: log response buffer
      console.log(`[DEBUG] Response buffer length: ${responseBuffer.length}`)

      // Check response for image file paths using doclibrary marker
      // Format: [DOCLIBRARY_IMAGE]/path/to/file.png[/DOCLIBRARY_IMAGE]
      const fs = require("fs")
      const imagePathRegex = /\[DOCLIBRARY_IMAGE\]([^\[]+)\[\/DOCLIBRARY_IMAGE\]/gi
      const matches = responseBuffer.matchAll(imagePathRegex)
      
      for (const match of matches) {
        const imagePath = match[1].trim()
        console.log(`Found doclibrary image: ${imagePath}`)
        if (imagePath && fs.existsSync(imagePath)) {
          await this.uploadImage(channel, imagePath)
        }
      }

      // Remove the image markers from the response before sending
      const cleanResponse = responseBuffer
        .replace(/\[DOCLIBRARY_IMAGE\][^\[]+\[\/DOCLIBRARY_IMAGE\]/gi, "")
        .trim()

      // Send the final response
      if (cleanResponse) {
        await say(cleanResponse)
      }
    } catch (err) {
      console.error("Error processing query:", err)
      await say("Sorry, something went wrong processing your request.")
    } finally {
      // Clean up listeners
      client.off("activity", activityHandler)
      client.off("chunk", chunkHandler)
    }
  }

  private async uploadImage(channel: string, filePath: string): Promise<void> {
    try {
      const fs = require("fs")
      const path = require("path")

      if (!fs.existsSync(filePath)) {
        console.error(`Image file not found: ${filePath}`)
        return
      }

      const fileName = path.basename(filePath)
      const fileBuffer = fs.readFileSync(filePath)

      // Upload file to Slack
      await this.app!.client.files.uploadV2({
        channel_id: channel,
        file: fileBuffer,
        filename: fileName,
        title: fileName,
      })

      console.log(`Uploaded image to ${channel}: ${fileName}`)
    } catch (err) {
      console.error(`Failed to upload image to ${channel}:`, err)
    }
  }

  async stop(): Promise<void> {
    console.log("\nStopping Slack connector...")

    // Disconnect all ACP sessions
    for (const [channel, session] of channelSessions) {
      try {
        await session.client.disconnect()
        console.log(`Disconnected ACP session for channel: ${channel}`)
      } catch {}
    }
    channelSessions.clear()

    // Stop Slack app
    if (this.app) {
      await this.app.stop()
    }

    console.log("Slack connector stopped.")
  }
}

// Main
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
