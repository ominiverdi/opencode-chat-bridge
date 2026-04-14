#!/usr/bin/env bun
/**
 * Slack Connector for OpenCode Chat Bridge
 *
 * Bridges Slack channels to OpenCode via ACP protocol.
 * Uses Socket Mode for real-time events without a public server.
 *
 * Thread Isolation:
 *   Sessions are keyed on channel:threadTs so each Slack thread gets its own
 *   isolated OpenCode session. Plain replies within a thread are forwarded to
 *   the bot automatically as long as an active session exists for that thread.
 *
 * Usage:
 *   bun connectors/slack.ts
 *
 * Environment variables:
 *   SLACK_BOT_TOKEN        - Bot User OAuth Token (starts with xoxb-)
 *   SLACK_APP_TOKEN        - App-Level Token for Socket Mode (starts with xapp-)
 *   SLACK_TRIGGER          - Trigger prefix (default: !oc)
 *   SESSION_RETENTION_MINS - Minutes of inactivity before session expires (default: 30)
 */

import fs from "fs"
import path from "path"
import { App } from "@slack/bolt"
import { ACPClient, type ActivityEvent } from "../src"
import { getConfig } from "../src/config"
import {
  BaseConnector,
  type BaseSession,
  parseCsvList,
  extractImagePaths,
  removeImageMarkers,
  sanitizeServerPaths,
} from "../src"

// =============================================================================
// Configuration
// =============================================================================

const config = getConfig()

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const APP_TOKEN = process.env.SLACK_APP_TOKEN
const TRIGGER = process.env.SLACK_TRIGGER || config.trigger
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)
const SESSION_RETENTION_MINS = parseSessionRetentionMins(process.env)
const RATE_LIMIT_SECONDS = 5
const THREAD_ISOLATION = config.slack.threadIsolation
const ENV_ALLOWED_USERS = parseCsvList(process.env.SLACK_ALLOWED_USERS)
const ALLOWED_USERS = ENV_ALLOWED_USERS.length > 0 ? ENV_ALLOWED_USERS : config.slack.allowedUsers

function parseSessionRetentionMins(env: NodeJS.ProcessEnv): number {
  const raw = env.SESSION_RETENTION_MINS
  if (raw) {
    const mins = parseInt(raw, 10)
    if (Number.isFinite(mins) && mins > 0) return mins
  }
  return 30
}

// =============================================================================
// Thread Context Helpers (pure, exported for testing)
// =============================================================================

/**
 * Normalized context extracted from any Slack event (mention, trigger, thread reply).
 */
export interface SlackEventContext {
  teamId: string
  channelId: string
  userId: string
  text: string
  eventTs: string
  threadTs?: string
  /** The thread_ts to use when replying (threadTs or eventTs as fallback) */
  replyThreadTs: string
  /** Session key: channel:threadRootTs */
  contextId: string
  /** Idempotency key: channel:eventTs */
  dedupeId: string
}

/**
 * Build the session key: channel:threadTs.
 * teamId is intentionally omitted -- Slack does not always include it in
 * Socket Mode payloads for private-channel messages, which would cause a
 * key mismatch between an @mention and a follow-up thread reply.
 * Channel IDs are globally unique within a workspace.
 */
export function buildSessionContextId(channelId: string, threadTsOrTs: string): string {
  return `${channelId}:${threadTsOrTs}`
}

/**
 * Resolve the thread root timestamp.
 * If the event has a threadTs it is a reply; otherwise the event itself starts the thread.
 */
export function resolveThreadTs(threadTs: string | undefined, eventTs: string): string {
  return threadTs || eventTs
}

/**
 * Normalize raw Slack event fields into a consistent SlackEventContext.
 * Throws if required fields (channelId, eventTs) are missing.
 */
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

  if (!channelId || !eventTs) {
    throw new Error("Missing required Slack fields: channel or ts")
  }

  const teamId = input.teamId || `ch_${channelId}`
  const replyThreadTs = resolveThreadTs(input.threadTs, eventTs)

  return {
    teamId,
    channelId,
    userId: input.userId || "unknown",
    text: input.text || "",
    eventTs,
    threadTs: input.threadTs,
    replyThreadTs,
    contextId: buildSessionContextId(channelId, replyThreadTs),
    dedupeId: `${channelId}:${eventTs}`,
  }
}

/**
 * Build the Slack API payload for a thread reply.
 * Throws if threadTs is empty (all replies must target a thread).
 */
export function buildThreadReplyPayload(channelId: string, threadTs: string, text: string): {
  channel: string
  text: string
  thread_ts: string
} {
  if (!threadTs) {
    throw new Error("Slack thread_ts is required for replies")
  }
  return { channel: channelId, text, thread_ts: threadTs }
}

/**
 * Post a reply into a Slack thread.
 */
export async function postThreadReply(
  client: { chat: { postMessage: (payload: { channel: string; text: string; thread_ts: string }) => Promise<unknown> } },
  channelId: string,
  threadTs: string,
  text: string
): Promise<void> {
  await client.chat.postMessage(buildThreadReplyPayload(channelId, threadTs, text))
}

/**
 * Returns true if a plain thread reply (no trigger, no mention) should be
 * considered for forwarding to the bot.
 * The caller must still check whether an active session exists for the thread.
 */
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

/**
 * Resolve the session ID based on threadIsolation config.
 * When true: channel:threadTs (per-thread sessions)
 * When false: channel (per-channel sessions, old behavior)
 */
export function resolveSessionId(
  channelId: string,
  replyThreadTs: string,
  threadIsolation: boolean
): string {
  if (threadIsolation) {
    return buildSessionContextId(channelId, replyThreadTs)
  }
  return channelId
}

// =============================================================================
// Session Type
// =============================================================================

interface ChannelSession extends BaseSession {}

// =============================================================================
// Slack Connector
// =============================================================================

export class SlackConnector extends BaseConnector<ChannelSession> {
  private app: App | null = null
  private threadIsolation: boolean

  constructor() {
    super({
      connector: "slack",
      trigger: TRIGGER,
      botName: "OpenCode Slack Bot",
      rateLimitSeconds: RATE_LIMIT_SECONDS,
      sessionRetentionDays: SESSION_RETENTION_DAYS,
      sessionRetentionMins: SESSION_RETENTION_MINS,
      allowedUsers: ALLOWED_USERS,
    })
    this.threadIsolation = THREAD_ISOLATION
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
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
    console.log(`  Thread isolation: ${this.threadIsolation ? "on (per-thread sessions)" : "off (per-channel sessions)"}`)
    await this.cleanupSessions()

    this.app = new App({
      token: BOT_TOKEN,
      appToken: APP_TOKEN,
      socketMode: true,
    })

    // -------------------------------------------------------------------------
    // Handler 1: @mention
    // -------------------------------------------------------------------------
    this.app.event("app_mention", async ({ event, body, client }) => {
      let context: SlackEventContext
      try {
        context = normalizeSlackEventContext({
          teamId: body?.team_id || (body as any)?.team?.id || event?.team || "",
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

      if (this.isDuplicateEvent(context.dedupeId)) return
      if (!this.isUserAllowed(context.userId)) return
      const sessionId = resolveSessionId(context.channelId, context.replyThreadTs, this.threadIsolation)
      this.touchSessionActivity(sessionId)
      this.log(`[MENTION] ${context.userId} in ${sessionId}: ${context.text}`)

      const query = context.text.replace(/<@[A-Z0-9]+>/g, "").trim()
      if (!query) return
      if (!this.checkRateLimit(context.userId)) return

      await this.processQuery(context, sessionId, query, client)
    })

    // -------------------------------------------------------------------------
    // Handler 2: trigger prefix (!oc ...)
    // -------------------------------------------------------------------------
    this.app.message(new RegExp(`^${TRIGGER}\\s+(.+)`, "i"), async ({ message, body, client }) => {
      if (!("text" in message) || !message.text) return
      if (!("user" in message) || !message.user) return
      if (!("channel" in message) || !message.channel) return

      const msgAny = message as any
      let context: SlackEventContext
      try {
        context = normalizeSlackEventContext({
          teamId: body?.team_id || (body as any)?.team?.id || (message as any)?.team || "",
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

      if (this.isDuplicateEvent(context.dedupeId)) return
      if (!this.isUserAllowed(context.userId)) return
      const sessionId = resolveSessionId(context.channelId, context.replyThreadTs, this.threadIsolation)
      this.touchSessionActivity(sessionId)
      this.log(`[MSG] ${context.userId} in ${sessionId}: ${context.text}`)

      const match = context.text.match(new RegExp(`^${TRIGGER}\\s+(.+)`, "i"))
      if (!match) return
      const query = match[1].trim()

      // Handle commands
      if (query.startsWith("/")) {
        await this.handleCommand(sessionId, query, async (text) => {
          await this.sendReply(client, context, text)
        })
        return
      }

      if (!this.checkRateLimit(context.userId)) return
      await this.processQuery(context, sessionId, query, client)
    })

    // -------------------------------------------------------------------------
    // Handler 3: plain thread reply (no trigger, no mention)
    // Only forwarded when an active session already exists for that thread.
    // Only active when threadIsolation is enabled.
    // -------------------------------------------------------------------------
    this.app.message(async ({ message, body, client }) => {
      if (!this.threadIsolation) return
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
      })) return

      let context: SlackEventContext
      try {
        context = normalizeSlackEventContext({
          teamId: body?.team_id || (body as any)?.team?.id || (message as any)?.team || "",
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

      if (this.isDuplicateEvent(context.dedupeId)) return
      if (!this.isUserAllowed(context.userId)) return

      // Only forward if there is already a session for this thread
      const sessionId = resolveSessionId(context.channelId, context.replyThreadTs, this.threadIsolation)
      if (!this.sessionManager.has(sessionId)) {
        return
      }

      this.log(`[THREAD] ${context.userId} in ${sessionId}: ${context.text}`)
      this.touchSessionActivity(sessionId)
      if (!this.checkRateLimit(context.userId)) return
      await this.processQuery(context, sessionId, context.text.trim(), client)
    })

    await this.app.start()
    this.startSessionExpiryLoop()
    this.log("Started! Listening for messages...")
  }

  async stop(): Promise<void> {
    this.log("Stopping...")
    await this.disconnectAllSessions()
    if (this.app) await this.app.stop()
    this.log("Stopped.")
  }

  // Required by BaseConnector -- not used directly (we use postThreadReply)
  async sendMessage(_channel: string, _text: string): Promise<void> {}

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Send a reply, respecting threadIsolation config.
   * When true: always reply in thread via thread_ts.
   * When false: reply in channel (no thread_ts).
   */
  private async sendReply(slackClient: any, context: SlackEventContext, text: string): Promise<void> {
    if (this.threadIsolation) {
      await postThreadReply(slackClient, context.channelId, context.replyThreadTs, text)
    } else {
      await slackClient.chat.postMessage({ channel: context.channelId, text })
    }
  }

  /**
   * Refresh lastActivity timestamp on an existing session.
   */
  private touchSessionActivity(sessionId: string): void {
    const session = this.sessionManager.get(sessionId)
    if (session) session.lastActivity = new Date()
  }

  // ---------------------------------------------------------------------------
  // Query processing
  // ---------------------------------------------------------------------------

  private async processQuery(context: SlackEventContext, sessionId: string, query: string, slackClient: any): Promise<void> {
    const startTime = Date.now()

    // Guard against concurrent queries on the same session
    if (this.isQueryActive(sessionId)) {
      await this.sendReply(slackClient, context, "A request is already running. Please wait for it to finish.")
      return
    }

    this.markQueryActive(sessionId)

    let session: ChannelSession | null = null
    let client: ACPClient | null = null
    let responseBuffer = ""
    let toolResultsBuffer = ""
    let lastActivityMessage = ""
    let toolCallCount = 0

    const activityHandler = async (activity: ActivityEvent) => {
      if (activity.type === "tool_start" && session) {
        toolCallCount++
        if (activity.message !== lastActivityMessage) {
          lastActivityMessage = activity.message
          session.lastActivity = new Date()
          await this.sendReply(slackClient, context, `> ${activity.message}`)
        }
      }
    }
    const chunkHandler = (text: string) => { responseBuffer += text }
    const updateHandler = (update: any) => {
      if (update.type === "tool_result" && update.toolResult) {
        toolResultsBuffer += update.toolResult
      }
    }
    const permissionHandler = async (event: { permission: string; path: string | null; message: string }) => {
      this.log(`[PERMISSION] Rejected: ${event.permission}${event.path ? ` (${event.path})` : ""}`)
      await this.sendReply(slackClient, context, `> ${event.message}`)
    }

    try {
      session = await this.getOrCreateSession(sessionId, (client) => ({
        ...this.createBaseSession(client),
      }))

      if (!session) {
        await this.sendReply(slackClient, context, "Sorry, I couldn't connect to the AI service.")
        return
      }

      session.messageCount++
      session.lastActivity = new Date()
      session.inputChars += query.length

      client = session.client
      client.on("activity", activityHandler)
      client.on("chunk", chunkHandler)
      client.on("update", updateHandler)
      client.on("permission_rejected", permissionHandler)

      await client.prompt(query)

      // Process images from tool results
      const toolPaths = extractImagePaths(toolResultsBuffer)
      for (const imagePath of toolPaths) {
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from tool result: ${imagePath}`)
          await this.uploadImage(context.channelId, imagePath, this.threadIsolation ? context.replyThreadTs : undefined)
        }
      }

      // Process images from response
      const responsePaths = extractImagePaths(responseBuffer)
      for (const imagePath of responsePaths) {
        if (toolPaths.includes(imagePath)) continue
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from response: ${imagePath}`)
          await this.uploadImage(context.channelId, imagePath, this.threadIsolation ? context.replyThreadTs : undefined)
        }
      }

      // Clean response and send
      const cleanResponse = sanitizeServerPaths(removeImageMarkers(responseBuffer))
      if (cleanResponse) {
        session.outputChars += cleanResponse.length
        await this.sendReply(slackClient, context, cleanResponse)
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const tools = toolCallCount > 0 ? `, ${toolCallCount} tool${toolCallCount > 1 ? "s" : ""}` : ""
      this.log(`[DONE] ${elapsed}s (${cleanResponse?.length ?? 0} chars${tools}) [${sessionId}]`)
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      this.logError(`[FAIL] ${elapsed}s [${sessionId}]:`, err)
      await this.sendReply(slackClient, context, "Sorry, something went wrong processing your request.")
    } finally {
      client?.off("activity", activityHandler)
      client?.off("chunk", chunkHandler)
      client?.off("update", updateHandler)
      client?.off("permission_rejected", permissionHandler)
      // Reset inactivity clock from moment of delivery
      if (session) session.lastActivity = new Date()
      this.markQueryDone(sessionId)
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
  process.on("SIGINT", async () => { await connector.stop(); process.exit(0) })
  process.on("SIGTERM", async () => { await connector.stop(); process.exit(0) })
  await connector.start()
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err)
    process.exit(1)
  })
}
