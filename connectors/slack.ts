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
 *   SESSION_RETENTION_MINS - Minutes of inactivity before session expires (default: 30)
 *
 * Thread Isolation Strategy:
 *   Sessions are keyed on `channel:threadTs` so each Slack thread gets its own
 *   isolated OpenCode session. Plain replies within a thread are forwarded to the
 *   bot automatically as long as an active session exists for that thread.
 */

import fs from "fs"
import path from "path"
import { App } from "@slack/bolt"
import { ACPClient, type ActivityEvent, type OpenCodeCommand } from "../src"
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

function resolveSessionRetentionMins(env: NodeJS.ProcessEnv): number {
  const raw = env.SESSION_RETENTION_MINS
  if (raw) {
    const mins = parseInt(raw, 10)
    if (Number.isFinite(mins) && mins > 0) return mins
  }
  return 30
}

// =============================================================================
// Exported pure helpers (also used by tests)
// =============================================================================

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

/**
 * Build the session key: channel:threadTs.
 * teamId is intentionally omitted — Slack does not always include it in
 * Socket Mode payloads for private-channel messages, which would cause a
 * key mismatch between an @mention and a follow-up thread reply.
 * Channel IDs are globally unique within a workspace, so channel:threadTs
 * is sufficient for per-thread isolation.
 */
export function buildSessionContextId(channelId: string, threadTsOrTs: string): string {
  return `${channelId}:${threadTsOrTs}`
}

export function resolveThreadTs(threadTs: string | undefined, eventTs: string): string {
  return threadTs || eventTs
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

  if (!channelId || !eventTs) {
    throw new Error("Missing required Slack fields: channel or ts")
  }

  // teamId is best-effort; fall back to a stable per-channel placeholder.
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
 * forwarded to the bot. The caller is still responsible for checking whether
 * an active session exists for the thread before acting on it.
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

function isLocalBridgeCommand(command: string): boolean {
  const cmd = command.toLowerCase().trim()
  return cmd === "/status" || cmd === "/clear" || cmd === "/reset" || cmd === "/help"
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
  private processedEvents = new Map<string, number>()
  private expiryInterval: NodeJS.Timeout | null = null
  /** Sessions with an active in-flight query — never evict these. */
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
    this.log(`Session retention: ${SESSION_RETENTION_MINS} minutes (inactivity)`)
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
      this.touchSessionActivity(context.contextId)
      this.log(`[MENTION] ${context.userId} in ${context.contextId}: ${context.text}`)

      const query = context.text.replace(/<@[A-Z0-9]+>/g, "").trim()
      if (!query) return
      if (!this.checkRateLimit(context.userId)) return

      await this.processQuery(context, query, client)
    })

    // -------------------------------------------------------------------------
    // Handler 2: trigger prefix (!sql …)
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
      this.touchSessionActivity(context.contextId)
      this.log(`[MSG] ${context.userId} in ${context.contextId}: ${context.text}`)

      const match = context.text.match(new RegExp(`^${TRIGGER}\\s+(.+)`, "i"))
      if (!match) return
      const query = match[1].trim()

      if (query.startsWith("/")) {
        const existingSession = this.sessionManager.get(context.contextId)
        const openCodeCommands: OpenCodeCommand[] = existingSession?.client.availableCommands || []

        if (!isLocalBridgeCommand(query) && openCodeCommands.length === 0) {
          await this.processQuery(context, query, client)
          return
        }

        await this.handleCommand(context.contextId, query, async (text) => {
          await postThreadReply(client, context.channelId, context.replyThreadTs, text)
        }, {
          openCodeCommands,
          forwardToOpenCode: async (command) => {
            await this.processQuery(context, command, client)
          },
        })
        return
      }

      if (!this.checkRateLimit(context.userId)) return
      await this.processQuery(context, query, client)
    })

    // -------------------------------------------------------------------------
    // Handler 3: plain thread reply (no trigger, no mention)
    // Only forwarded when an active session already exists for that thread.
    // -------------------------------------------------------------------------
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

      if (!this.sessionManager.has(context.contextId)) {
        this.log(`[THREAD] No active session for ${context.contextId} — ignoring`)
        return
      }

      this.log(`[THREAD] ${context.userId} in ${context.contextId}: ${context.text}`)
      this.touchSessionActivity(context.contextId)
      if (!this.checkRateLimit(context.userId)) return
      await this.processQuery(context, context.text.trim(), client)
    })

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
    if (this.app) await this.app.stop()
    this.log("Stopped.")
  }

  // Required by BaseConnector interface — not used directly (we use postThreadReply instead).
  async sendMessage(_channel: string, _text: string): Promise<void> {}

  // ---------------------------------------------------------------------------
  // Session expiry
  // ---------------------------------------------------------------------------

  private startSessionExpiryLoop(): void {
    if (this.expiryInterval) return
    this.expiryInterval = setInterval(() => {
      this.expireStaleSessions().catch((err) => {
        this.logError("[SESSION_EXPIRE] Sweep failed:", err)
      })
    }, 15_000)
  }

  private async expireStaleSessions(): Promise<void> {
    const now = Date.now()
    const stale: string[] = []

    for (const [id, session] of this.sessionManager.sessions) {
      if (this.activeQueries.has(id)) continue
      const inactiveMins = (now - session.lastActivity.getTime()) / 60_000
      if (inactiveMins >= SESSION_RETENTION_MINS) stale.push(id)
    }

    for (const id of stale) {
      const session = this.sessionManager.get(id)
      if (session) {
        try { await session.client.disconnect() } catch {}
      }
      this.sessionManager.delete(id)
      this.deleteSessionCacheDir(id)
      this.log(`[SESSION_EXPIRE] ${id} removed after ${SESSION_RETENTION_MINS}m inactivity`)
    }
  }

  private deleteSessionCacheDir(id: string): void {
    const dir = getSessionDir(this.config.connector, id)
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      this.logError(`[SESSION_EXPIRE] Failed cache cleanup for ${id}:`, err)
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private isDuplicateEvent(dedupeId: string): boolean {
    const now = Date.now()
    const maxAgeMs = 5 * 60 * 1000
    for (const [id, ts] of this.processedEvents) {
      if (now - ts > maxAgeMs) this.processedEvents.delete(id)
    }
    if (this.processedEvents.has(dedupeId)) return true
    this.processedEvents.set(dedupeId, now)
    return false
  }

  private touchSessionActivity(id: string): void {
    const session = this.sessionManager.get(id)
    if (session) session.lastActivity = new Date()
  }

  // ---------------------------------------------------------------------------
  // Query processing
  // ---------------------------------------------------------------------------

  private async processQuery(context: SlackEventContext, query: string, slackClient: any): Promise<void> {
    const startTime = Date.now()
    if (this.activeQueries.has(context.contextId)) {
      await postThreadReply(
        slackClient,
        context.channelId,
        context.replyThreadTs,
        "A request is already running in this thread. Please wait for it to finish."
      )
      return
    }

    this.activeQueries.add(context.contextId)

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
          await postThreadReply(slackClient, context.channelId, context.replyThreadTs, `> ${activity.message}`)
        }
      }
    }
    const chunkHandler = (text: string) => { responseBuffer += text }
    const updateHandler = (update: any) => {
      if (update.type === "tool_result" && update.toolResult) {
        toolResultsBuffer += JSON.stringify(update.toolResult)
      }
    }

    try {
      session = await this.getOrCreateSession(context.contextId, (client) => ({
        ...this.createBaseSession(client),
      }))

      if (!session) {
        await postThreadReply(slackClient, context.channelId, context.replyThreadTs,
          "Sorry, I couldn't connect to the AI service.")
        return
      }

      session.messageCount++
      session.lastActivity = new Date()
      session.inputChars += query.length

      client = session.client
      client.on("activity", activityHandler)
      client.on("chunk", chunkHandler)
      client.on("update", updateHandler)

      await client.prompt(query)

      const toolPaths = extractImagePaths(toolResultsBuffer)
      for (const imagePath of toolPaths) {
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from tool result: ${imagePath}`)
          await this.uploadImage(context.channelId, imagePath, context.replyThreadTs)
        }
      }
      const responsePaths = extractImagePaths(responseBuffer)
      for (const imagePath of responsePaths) {
        if (toolPaths.includes(imagePath)) continue
        if (fs.existsSync(imagePath)) {
          this.log(`Uploading image from response: ${imagePath}`)
          await this.uploadImage(context.channelId, imagePath, context.replyThreadTs)
        }
      }

      const cleanResponse = sanitizeServerPaths(removeImageMarkers(responseBuffer))
      if (cleanResponse) {
        session.outputChars += cleanResponse.length
        await postThreadReply(slackClient, context.channelId, context.replyThreadTs, cleanResponse)
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const tools = toolCallCount > 0 ? `, ${toolCallCount} tool${toolCallCount > 1 ? "s" : ""}` : ""
      this.log(`[DONE] ${elapsed}s (${cleanResponse?.length ?? 0} chars${tools}) [${context.contextId}]`)
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      this.logError(`[FAIL] ${elapsed}s [${context.contextId}]:`, err)
      await postThreadReply(slackClient, context.channelId, context.replyThreadTs,
        "Sorry, something went wrong processing your request.")
    } finally {
      client?.off("activity", activityHandler)
      client?.off("chunk", chunkHandler)
      client?.off("update", updateHandler)
      // Reset inactivity clock from moment of delivery, not start of query.
      if (session) session.lastActivity = new Date()
      this.activeQueries.delete(context.contextId)
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
