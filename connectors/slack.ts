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
 *   SLACK_BOT_TOKEN        - Bot User OAuth Token (starts with xoxb-)
 *   SLACK_APP_TOKEN        - App-Level Token for Socket Mode (starts with xapp-)
 *   SLACK_TRIGGER          - Trigger prefix (default: !oc)
 *   SESSION_RETENTION_MINS - Minutes to retain idle sessions (default: 30)
 *
 * Thread Isolation Strategy:
 *   Sessions are keyed on `channel_threadTs` rather than `channel` alone.
 *   For replies inside a thread: threadTs = event.thread_ts (the parent message ts).
 *   For top-level messages:      threadTs = message.ts (the message itself becomes the thread root).
 *   This ensures each Slack thread gets its own isolated opencode session.
 *   /clear only clears the current thread's context, not the whole channel.
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
import { getSessionDir } from "../src/session-utils"

// =============================================================================
// Configuration
// =============================================================================

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const APP_TOKEN = process.env.SLACK_APP_TOKEN
const TRIGGER = process.env.SLACK_TRIGGER || process.env.TRIGGER || "!oc"
const SESSION_RETENTION_MINS = resolveSessionRetentionMins(process.env)
const RATE_LIMIT_SECONDS = 5

export interface SlackEventContext {
  teamId: string
  channelId: string
  userId: string
  text: string
  eventTs: string
  threadTs?: string
  replyThreadTs: string
  contextId: string
  dedupeId: string
}

function resolveSessionRetentionMins(env: NodeJS.ProcessEnv): number {
  const minsRaw = env.SESSION_RETENTION_MINS
  if (minsRaw) {
    const mins = parseInt(minsRaw, 10)
    if (Number.isFinite(mins) && mins > 0) return mins
  }

  return 30
}

export function shouldHandleThreadMessage(input: {
  text: string
  threadTs?: string
  trigger: string
  subtype?: string
  botId?: string
}): boolean {
  const blockedSubtypes = new Set(["bot_message", "message_changed", "message_deleted"])

  const text = input.text.trim()
  if (!text) return false
  if (!input.threadTs) return false
  if (input.subtype && blockedSubtypes.has(input.subtype)) return false
  if (input.botId) return false
  if (text.toLowerCase().startsWith(`${input.trigger.toLowerCase()} `)) return false
  if (/^<@[A-Z0-9]+>/.test(text)) return false
  return true
}

function extractTeamId(body: any, event: any): string {
  return body?.team_id || body?.team?.id || event?.team || ""
}

export function resolveThreadTs(threadTs: string | undefined, eventTs: string): string {
  return threadTs || eventTs
}

export function buildThreadContextId(teamId: string, channelId: string, threadTsOrTs: string): string {
  return `${teamId}:${channelId}:${threadTsOrTs}`
}

/**
 * Build a session context ID from channel and thread root timestamp only.
 * This is the canonical key used for session lookups — it intentionally omits
 * teamId because Slack does not always include team_id in Socket Mode message
 * payloads (e.g. private-channel thread replies), which would cause a key mismatch
 * between the session created on an @mention and the follow-up thread message.
 *
 * Channel IDs are globally unique within a Slack workspace, so
 * `channel:threadTs` is sufficient for per-thread isolation.
 */
export function buildSessionContextId(channelId: string, threadTsOrTs: string): string {
  return `${channelId}:${threadTsOrTs}`
}

export function normalizeSlackEventContext(input: {
  teamId?: string
  channelId?: string
  userId?: string
  text?: string
  eventTs?: string
  threadTs?: string
}): SlackEventContext {
  const channelId = input.channelId || ""
  const eventTs = input.eventTs || ""
  const userId = input.userId || "unknown"
  const text = input.text || ""

  if (!channelId || !eventTs) {
    throw new Error("Missing required Slack fields: channel or ts")
  }

  // teamId is best-effort: Slack does not always include team_id in Socket Mode
  // message payloads (e.g. private-channel thread replies). Fall back to a stable
  // placeholder so the context key stays unique and consistent per channel.
  const teamId = input.teamId || `ch_${channelId}`

  const replyThreadTs = resolveThreadTs(input.threadTs, eventTs)
  if (!replyThreadTs) {
    throw new Error("Unable to determine Slack thread_ts")
  }

  // Use channel:threadTs as the session key (omitting teamId) so that
  // follow-up thread messages without team_id in the payload resolve to the
  // same session that was created on the initial @mention.
  const contextId = buildSessionContextId(channelId, replyThreadTs)

  return {
    teamId,
    channelId,
    userId,
    text,
    eventTs,
    threadTs: input.threadTs,
    replyThreadTs,
    contextId,
    dedupeId: `${channelId}:${eventTs}`,
  }
}

export function buildThreadReplyPayload(channelId: string, threadTs: string, text: string): {
  channel: string
  text: string
  thread_ts: string
} {
  if (!threadTs) {
    throw new Error("Slack thread_ts is required for replies")
  }

  return {
    channel: channelId,
    text,
    thread_ts: threadTs,
  }
}

export async function postThreadReply(
  client: { chat: { postMessage: (payload: { channel: string; text: string; thread_ts: string }) => Promise<unknown> } },
  channelId: string,
  threadTs: string,
  text: string
): Promise<void> {
  await client.chat.postMessage(buildThreadReplyPayload(channelId, threadTs, text))
}

// =============================================================================
// Session Type
// =============================================================================

interface ChannelSession extends BaseSession {
}

// =============================================================================
// Slack Connector
// =============================================================================

export class SlackConnector extends BaseConnector<ChannelSession> {
  private app: App | null = null
  private processedEvents = new Map<string, number>()
  private expiryInterval: NodeJS.Timeout | null = null
  /** Sessions with an active in-flight query; never evict these. */
  private activeQueries = new Set<string>()

  constructor() {
    super({
      connector: "slack",
      trigger: TRIGGER,
      botName: "OpenCode Slack Bot",
      rateLimitSeconds: RATE_LIMIT_SECONDS,
      sessionRetentionDays: SESSION_RETENTION_MINS / (24 * 60),
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
    this.log(`Session retention: ${SESSION_RETENTION_MINS} minutes (inactivity)`)
    await this.cleanupSessions()

    // Create Slack app with Socket Mode
    this.app = new App({
      token: BOT_TOKEN,
      appToken: APP_TOKEN,
      socketMode: true,
    })

    // Handle app mentions (@bot)
    this.app.event("app_mention", async ({ event, body, client }) => {
      let context: SlackEventContext
      try {
        context = normalizeSlackEventContext({
          teamId: extractTeamId(body, event),
          channelId: event.channel,
          userId: event.user,
          text: event.text,
          eventTs: event.ts,
          threadTs: event.thread_ts,
        })
      } catch (err) {
        this.logError("[MENTION] Invalid event payload:", err)
        return
      }

      if (this.isDuplicateEvent(context.dedupeId)) {
        this.log(`[DUPLICATE] Skipping ${context.dedupeId}`)
        return
      }

      this.touchSessionActivity(context.contextId)

      this.log(`[MENTION] ${context.userId} in ${context.contextId}: ${context.text}`)

      // Extract query (remove the mention)
      const query = context.text.replace(/<@[A-Z0-9]+>/g, "").trim()
      if (!query) return

      // Rate limiting
      if (!this.checkRateLimit(context.userId)) return

      await this.processQuery(context, query, client)
    })

    // Handle messages with trigger prefix
    this.app.message(new RegExp(`^${TRIGGER}\\s+(.+)`, "i"), async ({ message, body, client }) => {
      // Type guard for message with text and user
      if (!("text" in message) || !message.text) return
      if (!("user" in message) || !message.user) return
      if (!("channel" in message) || !message.channel) return

      const msgAny = message as any
      let context: SlackEventContext
      try {
        context = normalizeSlackEventContext({
          teamId: extractTeamId(body, message),
          channelId: message.channel,
          userId: message.user,
          text: message.text,
          eventTs: msgAny.ts,
          threadTs: msgAny.thread_ts,
        })
      } catch (err) {
        this.logError("[MSG] Invalid event payload:", err)
        return
      }

      if (this.isDuplicateEvent(context.dedupeId)) {
        this.log(`[DUPLICATE] Skipping ${context.dedupeId}`)
        return
      }

      this.touchSessionActivity(context.contextId)

      this.log(`[MSG] ${context.userId} in ${context.contextId}: ${context.text}`)

      // Extract query after trigger
      const match = context.text.match(new RegExp(`^${TRIGGER}\\s+(.+)`, "i"))
      if (!match) return
      const query = match[1].trim()

      // Handle commands
      if (query.startsWith("/")) {
        await this.handleCommand(context.contextId, query, async (text) => {
          await this.sendThreadReply(client, context.channelId, context.replyThreadTs, text)
        })
        return
      }

      // Rate limiting
      if (!this.checkRateLimit(context.userId)) return

      await this.processQuery(context, query, client)
    })

    this.app.message(async ({ message, body, client }) => {
      if (!("text" in message) || !message.text) return
      if (!("user" in message) || !message.user) return
      if (!("channel" in message) || !message.channel) return

      const msgAny = message as any
      if (!shouldHandleThreadMessage({
        text: message.text,
        threadTs: msgAny.thread_ts,
        trigger: TRIGGER,
        subtype: msgAny.subtype,
        botId: msgAny.bot_id,
      })) {
        return
      }

      let context: SlackEventContext
      try {
        context = normalizeSlackEventContext({
          teamId: extractTeamId(body, message),
          channelId: message.channel,
          userId: message.user,
          text: message.text,
          eventTs: msgAny.ts,
          threadTs: msgAny.thread_ts,
        })
      } catch (err) {
        this.logError("[THREAD] Invalid event payload:", err)
        return
      }

      if (this.isDuplicateEvent(context.dedupeId)) {
        this.log(`[DUPLICATE] Skipping ${context.dedupeId}`)
        return
      }

      this.log(`[THREAD] ${context.userId} in ${context.contextId}: ${context.text}`)

      this.touchSessionActivity(context.contextId)
      if (!this.checkRateLimit(context.userId)) return
      await this.processQuery(context, context.text.trim(), client)
    })

    // Start the app
    await this.app.start()
    this.startSessionExpiryLoop()
    this.log("Started! Listening for messages...")
  }

  async stop(): Promise<void> {
    this.log("Stopping...")
    if (this.expiryInterval) {
      clearInterval(this.expiryInterval)
      this.expiryInterval = null
    }
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

  private isDuplicateEvent(dedupeId: string): boolean {
    const now = Date.now()
    const maxAgeMs = 5 * 60 * 1000

    for (const [id, ts] of this.processedEvents) {
      if (now - ts > maxAgeMs) {
        this.processedEvents.delete(id)
      }
    }

    if (this.processedEvents.has(dedupeId)) {
      return true
    }

    this.processedEvents.set(dedupeId, now)
    return false
  }

  private sessionInactivityMinutes(session: ChannelSession): number {
    return (Date.now() - session.lastActivity.getTime()) / 60000
  }

  private touchSessionActivity(id: string): void {
    const session = this.sessionManager.get(id)
    if (!session) return
    session.lastActivity = new Date()
  }

  private sessionContextIdToDir(id: string): string {
    return getSessionDir(this.config.connector, id)
  }

  private deleteSessionCacheDir(id: string): void {
    const dir = this.sessionContextIdToDir(id)
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch (err) {
      this.logError(`[SESSION_EXPIRE] Failed cache cleanup for ${id}:`, err)
    }
  }

  private async evictSession(id: string): Promise<void> {
    const session = this.sessionManager.get(id)
    if (session) {
      try {
        await session.client.disconnect()
      } catch {}
    }
    this.sessionManager.delete(id)
    this.deleteSessionCacheDir(id)
  }

  private startSessionExpiryLoop(): void {
    if (this.expiryInterval) return

    this.expiryInterval = setInterval(() => {
      this.expireStaleSessions().catch((err) => {
        this.logError("[SESSION_EXPIRE] Sweep failed:", err)
      })
    }, 15000)
  }

  private async expireStaleSessions(): Promise<void> {
    const stale: Array<{ id: string; session: ChannelSession }> = []
    for (const [id, session] of this.sessionManager.sessions) {
      // Never evict a session that has an active in-flight query
      if (this.activeQueries.has(id)) continue
      if (this.sessionInactivityMinutes(session) >= SESSION_RETENTION_MINS) {
        stale.push({ id, session })
      }
    }

    for (const { id } of stale) {
      await this.evictSession(id)
      this.log(`[SESSION_EXPIRE] ${id} removed after ${SESSION_RETENTION_MINS}m inactivity`)
    }
  }

  private async getOrCreateThreadSession(context: SlackEventContext): Promise<ChannelSession | null> {
    return await this.getOrCreateSession(context.contextId, (client) => this.createSession(client))
  }

  private async sendThreadReply(
    client: any,
    channelId: string,
    threadTs: string,
    text: string
  ): Promise<void> {
    await postThreadReply(client, channelId, threadTs, text)
  }

  private async processQuery(context: SlackEventContext, query: string, slackClient: any): Promise<void> {
    const startTime = Date.now()

    // Get or create session (keyed per thread)
    const session = await this.getOrCreateThreadSession(context)

    if (!session) {
      await this.sendThreadReply(
        slackClient,
        context.channelId,
        context.replyThreadTs,
        "Sorry, I couldn't connect to the AI service."
      )
      return
    }

    // Update session stats
    session.messageCount++
    session.lastActivity = new Date()
    session.inputChars += query.length

    // Mark this session as having an active query so the expiry loop won't
    // evict it mid-response (even if the query takes longer than SESSION_RETENTION_MINS).
    this.activeQueries.add(context.contextId)

    const client = session.client

    // Track response chunks
    let responseBuffer = ""
    let toolResultsBuffer = ""
    let lastActivityMessage = ""
    let toolCallCount = 0

    // Activity events - show what the AI is doing
    const activityHandler = async (activity: ActivityEvent) => {
      if (activity.type === "tool_start") {
        toolCallCount++
        if (activity.message !== lastActivityMessage) {
          lastActivityMessage = activity.message
          // Keep inactivity clock from ticking during active tool calls
          session.lastActivity = new Date()
          await this.sendThreadReply(slackClient, context.channelId, context.replyThreadTs, `> ${activity.message}`)
        }
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
          await this.uploadImage(context.channelId, imagePath, context.replyThreadTs)
        }
      }

      // Process images from response (model might echo paths)
      const responsePaths = extractImagePaths(responseBuffer)
      for (const imagePath of responsePaths) {
        // Skip if already uploaded from tool results
        if (toolPaths.includes(imagePath)) continue
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from response: ${imagePath}`)
          await this.uploadImage(context.channelId, imagePath, context.replyThreadTs)
        }
      }

      // Clean response and send
      const cleanResponse = sanitizeServerPaths(removeImageMarkers(responseBuffer))
      if (cleanResponse) {
        session.outputChars += cleanResponse.length
        await this.sendThreadReply(slackClient, context.channelId, context.replyThreadTs, cleanResponse)
      }
      // Log elapsed time
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const outChars = cleanResponse ? cleanResponse.length : 0
      const tools = toolCallCount > 0 ? `, ${toolCallCount} tool${toolCallCount > 1 ? "s" : ""}` : ""
      this.log(`[DONE] ${elapsed}s (${outChars} chars${tools}) [${context.contextId}]`)
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      this.logError(`[FAIL] ${elapsed}s [${context.contextId}]:`, err)
      await this.sendThreadReply(
        slackClient,
        context.channelId,
        context.replyThreadTs,
        "Sorry, something went wrong processing your request."
      )
    } finally {
      client.off("activity", activityHandler)
      client.off("chunk", chunkHandler)
      client.off("update", updateHandler)
      // Unmark active query and reset the inactivity clock to now so the
      // retention window starts from when the response was delivered.
      session.lastActivity = new Date()
      this.activeQueries.delete(context.contextId)
    }
  }

  private createSession(client: ACPClient): ChannelSession {
    return {
      ...this.createBaseSession(client),
    }
  }

  private async uploadImage(channel: string, filePath: string, threadTs?: string): Promise<void> {
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
        ...(threadTs ? { thread_ts: threadTs } : {}),
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

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err)
    process.exit(1)
  })
}
