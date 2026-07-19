#!/usr/bin/env bun
/**
 * Telegram Connector for OpenCode Chat Bridge
 *
 * Bridges Telegram chats to OpenCode via ACP protocol.
 * Uses the Telegram Bot API (HTTP) via native fetch + long-polling
 * (`getUpdates`). Zero external runtime dependencies.
 *
 * Thread Isolation (configurable via chat-bridge.json telegram.threadIsolation):
 *   When enabled (default), sessions in forum supergroups are scoped per topic
 *   using `${chatId}:${messageThreadId}`. Each topic gets its own isolated
 *   OpenCode session and replies are posted inside the topic.
 *   In non-forum chats, sessions are keyed on `chatId` only (one session per
 *   chat), so a group and a DM with the same user share a session only if
 *   they share a chat id (which they don't).
 *
 * Usage:
 *   bun connectors/telegram.ts
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN    - Bot token from @BotFather (required)
 *   TELEGRAM_ALLOWED_USERS - Optional CSV of Telegram user IDs allowed to use
 *                            the bot; messages from others are silently dropped
 *   TELEGRAM_TRIGGER      - Optional trigger override (default: !oc)
 *   TELEGRAM_DROP_PENDING - If "1", drop backlogged updates on startup so the
 *                            bot only sees new messages after launch
 */

import fs from "fs"
import path from "path"
import { ACPClient, type ActivityEvent, type ImageContent } from "../src"
import { getConfig } from "../src/config"
import {
  BaseConnector,
  CommandHandler,
  type BaseSession,
  parseCsvList,
  formatToolCallMessage,
  shouldShowToolOutput,
  extractImagePaths,
  extractDocPaths,
  removeImageMarkers,
  removeDocMarkers,
  sanitizeServerPaths,
  getSessionDir,
  ensureSessionDir,
} from "../src"

// =============================================================================
// Configuration
// =============================================================================

const config = getConfig()
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || config.telegram.token || ""
const TRIGGER = process.env.TELEGRAM_TRIGGER || config.trigger
const BOT_NAME = config.botName
const RATE_LIMIT_SECONDS = config.rateLimitSeconds
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS || "7", 10)
const THREAD_ISOLATION = config.telegram.threadIsolation
const DROP_PENDING = process.env.TELEGRAM_DROP_PENDING === "1"
const ENV_ALLOWED_USERS = parseCsvList(process.env.TELEGRAM_ALLOWED_USERS)
const ALLOWED_USERS = ENV_ALLOWED_USERS.length > 0 ? ENV_ALLOWED_USERS : config.telegram.allowedUsers

const TG_API_BASE = `https://api.telegram.org/bot${TG_TOKEN}`
const TG_FILE_BASE = `https://api.telegram.org/file/bot${TG_TOKEN}`
const POLL_TIMEOUT_SECS = 30
const MAX_MESSAGE_LENGTH = 4096
const UPLOADS_SUBDIR = "uploads"
/** Telegram Bot API hard download limit; refuse larger files up-front. */
const TELEGRAM_API_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const ATTACHMENTS_ENABLED = config.telegram.attachments?.enabled ?? true
const MAX_DOWNLOAD_BYTES = Math.min(
  TELEGRAM_API_MAX_DOWNLOAD_BYTES,
  Math.max(1, config.telegram.attachments?.maxFileBytes ?? TELEGRAM_API_MAX_DOWNLOAD_BYTES)
)
const MAX_ATTACHMENTS_PER_MESSAGE = Math.max(1, config.telegram.attachments?.maxFilesPerMessage ?? 4)

// =============================================================================
// Telegram Bot API helpers
// =============================================================================

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

class TelegramApiError extends Error {
  status?: number
  retryAfter?: number
  constructor(message: string, status?: number, retryAfter?: number) {
    super(message)
    this.name = "TelegramApiError"
    this.status = status
    this.retryAfter = retryAfter
  }
}

/**
 * Build a TelegramApiError from a non-2xx Bot API response.
 * Telegram can include JSON error bodies, including parameters.retry_after
 * for HTTP 429. Preserve that value so pollLoop can honor server backoff.
 */
async function telegramHttpError(res: Response, context: string): Promise<TelegramApiError> {
  const text = await res.text().catch(() => "")
  let description = text.slice(0, 200)
  let retryAfter: number | undefined
  let errorCode: number | undefined

  if (text) {
    try {
      const json = JSON.parse(text) as TelegramApiResponse<unknown>
      description = json.description || description
      retryAfter = json.parameters?.retry_after
      errorCode = json.error_code
    } catch {
      // Keep the plain-text fallback above.
    }
  }

  const status = errorCode || res.status
  const suffix = description ? `: ${description}` : ""
  return new TelegramApiError(`${context} HTTP ${res.status}${suffix}`, status, retryAfter)
}

/**
 * Issue a JSON POST to the Telegram Bot API. Throws TelegramApiError on
 * non-OK responses. Adds no runtime dependencies.
 */
async function tgApi<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const url = `${TG_API_BASE}/${method}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  // Telegram may return JSON errors even for non-2xx responses.
  if (!res.ok) {
    throw await telegramHttpError(res, `Telegram API ${method}`)
  }

  // JSON parse errors are surfaced as exceptions from .json()
  const json = (await res.json()) as TelegramApiResponse<T>
  if (!json.ok) {
    throw new TelegramApiError(
      json.description || `Telegram API ${method} failed`,
      json.error_code,
      json.parameters?.retry_after
    )
  }
  return json.result as T
}

/**
 * Multipart upload for files (photo / document).
 */
async function tgUpload<T = unknown>(
  method: string,
  fields: Record<string, string>,
  filePath: string,
  fileField: string
): Promise<T> {
  const url = `${TG_API_BASE}/${method}`
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, v)
  }
  const buffer = fs.readFileSync(filePath)
  form.append(fileField, new Blob([buffer]), path.basename(filePath))

  const res = await fetch(url, { method: "POST", body: form })

  if (!res.ok) {
    throw await telegramHttpError(res, `Telegram upload ${method}`)
  }
  const json = (await res.json()) as TelegramApiResponse<T>
  if (!json.ok) {
    throw new TelegramApiError(
      json.description || `Telegram upload ${method} failed`,
      json.error_code,
      json.parameters?.retry_after
    )
  }
  return json.result as T
}

/**
 * Download a previously-resolved Telegram file path to a local file on disk.
 * Telegram caps Bot API downloads at MAX_DOWNLOAD_BYTES and returns errors
 * for files that exceed the limit -- we surface a clear `TelegramApiError`
 * so the caller can skip oversized attachments without crashing.
 */
async function tgDownloadFile(filePath: string, destPath: string): Promise<number> {
  const url = `${TG_FILE_BASE}/${filePath}`
  const res = await fetch(url)

  if (!res.ok) {
    throw await telegramHttpError(res, `Telegram file download ${filePath}`)
  }

  const contentLength = Number(res.headers.get("content-length") || 0)
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    // Drain the body so the underlying connection is reusable.
    await res.arrayBuffer().catch(() => {})
    throw new TelegramApiError(
      `Telegram file exceeds ${MAX_DOWNLOAD_BYTES}-byte download limit (${contentLength} bytes)`,
      413
    )
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new TelegramApiError(
      `Downloaded Telegram file exceeds ${MAX_DOWNLOAD_BYTES}-byte limit (${buffer.length} bytes)`,
      413
    )
  }
  fs.writeFileSync(destPath, buffer)
  return buffer.length
}

/**
 * Compose a safe, unique local filename for an attachment.
 *
 * Prefers the user's original `file_name` (or the extension Telegram returned
 * via `getFile`), falls back to the per-kind default extension, and prefixes
 * the basename with a timestamp + random suffix so concurrent downloads of
 * identical files never collide.
 */
export function sanitizeAttachmentExtension(ext: string | undefined, fallback: string): string {
  const cleaned = (ext || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 16)
  return cleaned || fallback
}

export function buildAttachmentFilename(
  attachment: TelegramAttachment,
  resolvedFilePath: string
): string {
  const origName = attachment.fileName || attachment.kind
  const origExt = origName.includes(".") ? origName.split(".").pop() : undefined
  const resolvedBase = path.basename(resolvedFilePath)
  const resolvedExt = resolvedBase.includes(".") ? resolvedBase.split(".").pop() : undefined
  const candidateExt = sanitizeAttachmentExtension(
    origExt || resolvedExt,
    DEFAULT_EXT_BY_KIND[attachment.kind]
  )

  const safeBase = origName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 80) || attachment.kind
  // Avoid dotted extensions in the base; guarantee the final basename ends in
  // exactly one sanitized extension.
  const baseNoExt = safeBase.replace(/\.[^.]+$/, "")
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return `${stamp}-${baseNoExt}.${candidateExt}`
}

// =============================================================================
// Telegram event context helpers (pure, exported for testing)
// =============================================================================

/**
 * Normalised context extracted from a Telegram update. Plain data only,
 * no platform object references, so tests can construct it freely.
 */
export interface TelegramEventContext {
  /** Telegram chat.id (positive integer or negative for groups), stringified */
  chatId: string
  /** Telegram from.id (always positive integer for real users), stringified */
  userId: string
  /** Telegram message_id used for reply_to_message_id */
  messageId: number
  /** Trimmed message text (or caption), empty string if absent */
  text: string
  /** message_thread_id when is_topic_message === true, null otherwise */
  messageThreadId: number | null
  /** message_id of the parent (when this is a reply), null otherwise */
  replyToMessageId: number | null
  /** Author user id of the parent message (when this is a reply), null otherwise */
  replyToMessageFromId: string | null
  /** True iff the parent message's `from.is_bot === true` (when this is a reply) */
  replyToMessageIsBot: boolean
  /** One of: "private" | "group" | "supergroup" | "channel" */
  chatType: string
  /** True only for messages inside a forum supergroup topic */
  isForumTopic: boolean
  /** True for direct messages with the bot */
  isPrivate: boolean
  /** Session key -- chatId, or chatId:messageThreadId when threadIsolation applies */
  sessionId: string
  /** Idempotency key -- chatId:messageId */
  dedupeId: string
}

/** Input shape for normalising a Telegram message. */
export interface TelegramNormalizeInput {
  chat: { id: number | string; type: string; is_forum?: boolean }
  from: { id: number | string; is_bot?: boolean; username?: string; first_name?: string }
  messageId: number
  text?: string
  is_topic_message?: boolean
  message_thread_id?: number
  reply_to_message?: {
    message_id: number
    from?: { id: number | string; is_bot?: boolean; username?: string; first_name?: string }
  }
}

/**
 * Resolve the forum topic thread id.
 * Only meaningful when the chat has topics enabled AND the message was posted
 * as a topic message -- otherwise Telegram leaves message_thread_id unset.
 */
export function resolveMessageThreadId(input: {
  is_topic_message?: boolean
  message_thread_id?: number
}): number | null {
  if (input.is_topic_message && typeof input.message_thread_id === "number") {
    return input.message_thread_id
  }
  return null
}

/**
 * Build the session key. When threadIsolation is enabled AND we're inside a
 * forum topic, key on `${chatId}:${messageThreadId}` so each topic gets its
 * own isolated OpenCode session. Otherwise, key on chatId only.
 */
export function buildTelegramSessionId(
  chatId: string,
  messageThreadId: number | null,
  threadIsolation: boolean
): string {
  if (threadIsolation && messageThreadId !== null) {
    return `${chatId}:${messageThreadId}`
  }
  return chatId
}

/**
 * Pure function -- turn a raw Telegram message payload into a
 * TelegramEventContext. Exported for unit and integration tests.
 */
export function normalizeTelegramEventContext(
  input: TelegramNormalizeInput,
  threadIsolation: boolean
): TelegramEventContext {
  const chatId = String(input.chat.id)
  const userId = String(input.from.id)
  const messageThreadId = resolveMessageThreadId(input)
  const text = (input.text || "").trim()
  const replyToMessageId = input.reply_to_message?.message_id ?? null
  const replyToMessageFromId =
    input.reply_to_message?.from !== undefined && input.reply_to_message.from.id !== undefined
      ? String(input.reply_to_message.from.id)
      : null
  const replyToMessageIsBot = Boolean(input.reply_to_message?.from?.is_bot)
  const isForumTopic = Boolean(input.chat.is_forum) && Boolean(input.is_topic_message)

  return {
    chatId,
    userId,
    messageId: input.messageId,
    text,
    messageThreadId,
    replyToMessageId,
    replyToMessageFromId,
    replyToMessageIsBot,
    chatType: input.chat.type,
    isForumTopic,
    isPrivate: input.chat.type === "private",
    sessionId: buildTelegramSessionId(chatId, messageThreadId, threadIsolation),
    dedupeId: `${chatId}:${input.messageId}`,
  }
}

/**
 * Decide whether a plain message inside a topic (no trigger, no @mention) should
 * still be forwarded, because we already have an active session for that topic.
 *
 * The caller still has to verify an active session exists for the
 * context.sessionId; this only decides eligibility.
 */
export function shouldHandleImplicitTopicReply(input: {
  text: string
  isPrivate: boolean
  messageThreadId: number | null
  trigger: string
  botUsername?: string
}): boolean {
  if (!input.text) return false
  if (input.isPrivate) return false
  if (input.messageThreadId === null) return false
  const lower = input.text.toLowerCase()
  const triggerLower = input.trigger.toLowerCase()
  if (lower.startsWith(`${triggerLower} `)) return false
  if (lower === triggerLower) return false
  if (input.botUsername) {
    const mentionLower = `@${input.botUsername.toLowerCase()}`
    if (lower.startsWith(`${mentionLower} `)) return false
    if (lower === mentionLower) return false
  }
  return true
}

/**
 * Decide whether a plain message that is a swipe-reply to one of this bot's
 * own messages should be forwarded without a trigger/mention.
 *
 * The connector still has to verify an active session exists for the
 * relevant chat/topic. Pure data only -- the `ourBotId` parameter lets the
 * caller narrow the match to "this bot" rather than any bot in the chat.
 *
 * Returns false when the option is disabled, when the message is not a
 * reply, when the parent message was not authored by a bot at all, when the
 * parent author doesn't match our bot id, or when the message text is empty.
 * The trigger/mention guards are inherited from `shouldHandleImplicitTopicReply`:
 * a swipe-reply to the bot whose text also starts with the trigger is fine
 * here -- the trigger-prefix branch is what catches it in the caller.
 */
export function shouldHandleTelegramBotReply(input: {
  enabled: boolean
  text: string
  isPrivate: boolean
  replyToMessageIsBot: boolean
  replyToMessageFromId: string | null
  ourBotId: number
}): boolean {
  if (!input.enabled) return false
  if (!input.text) return false
  if (!input.replyToMessageIsBot) return false
  if (input.replyToMessageFromId === null) return false
  if (String(input.ourBotId) !== input.replyToMessageFromId) return false
  // The DM case is already handled by the catch-all `ctx.isPrivate` branch in
  // the caller's decision tree, but we accept it here too for completeness
  // and so this helper is self-contained in tests.
  void input.isPrivate
  return true
}

// =============================================================================
// Incoming file attachments
// =============================================================================

/**
 * Categories of media that can be attached to a Telegram message. Maps
 * 1:1 to the message-object field names so we can correlate when downloading.
 */
export type TelegramAttachmentKind =
  | "photo"
  | "document"
  | "video"
  | "video_note"
  | "audio"
  | "voice"
  | "animation"
  | "sticker"

/**
 * A file attached to an incoming Telegram message. The bot downloads the
 * binary via `getFile` and exposes the local path to the LLM.
 *
 * Photos are arrays of `PhotoSize` in the Telegram payload; `extractTelegramAttachments`
 * picks the largest variant and exposes it as a single attachment with kind="photo".
 */
export interface TelegramAttachment {
  kind: TelegramAttachmentKind
  /** Telegram file_id; passed to `getFile` to obtain the download URL. */
  fileId: string
  /** Original filename when reported (documents / animations / videos / audio). */
  fileName?: string
  /** MIME type when reported, or a sensible default per kind. */
  mimeType?: string
  /** File size in bytes when reported by Telegram. */
  size?: number
}

/**
 * Default MIME types per attachment kind. Telegram doesn't always set them
 * (e.g. voice, sticker) so we supply reasonable fallbacks for downstream
 * prompts and filename inference.
 */
const DEFAULT_MIME_BY_KIND: Record<TelegramAttachmentKind, string> = {
  photo: "image/jpeg",
  document: "application/octet-stream",
  video: "video/mp4",
  video_note: "video/mp4",
  audio: "audio/mpeg",
  voice: "audio/ogg",
  animation: "video/mp4",
  sticker: "image/webp",
}

const DEFAULT_EXT_BY_KIND: Record<TelegramAttachmentKind, string> = {
  photo: "jpg",
  document: "bin",
  video: "mp4",
  video_note: "mp4",
  audio: "mp3",
  voice: "ogg",
  animation: "mp4",
  sticker: "webp",
}

/**
 * Pure, dependency-free extractor for Telegram message attachments.
 *
 * Telegram represents a photo as an array of `PhotoSize` variants (different
 * resolutions); we pick the one with the largest `file_size`, falling back
 * to the last entry when sizes are absent.
 *
 * All other kinds are single objects. For each kind we capture `file_id`
 * plus optional `file_name`, `mime_type`, and `file_size`. Stickers and
 * voice notes don't carry `mime_type`, so callers can use the per-kind
 * defaults via {@link DEFAULT_MIME_BY_KIND}.
 *
 * Exported for unit and integration tests.
 */
export function extractTelegramAttachments(
  message: Record<string, unknown>
): TelegramAttachment[] {
  const out: TelegramAttachment[] = []

  // Photo: array of PhotoSize objects
  const photo = message.photo
  if (Array.isArray(photo) && photo.length > 0) {
    // Photos are arrays of `PhotoSize` variants; pick the largest one. Telegram
    // reports `file_size` inconsistently, so:
    //  - if any entry has a known size, that's the source of truth, and
    //  - entries without `file_id` are dropped (they can't be downloaded).
    let sized: any = null
    for (const p of photo) {
      if (!p || typeof p !== "object") continue
      if (!p.file_id) continue
      if (typeof p.file_size !== "number") continue
      if (!sized || p.file_size > sized.file_size) sized = p
    }

    // If no entry carried a known size, Telegram sorts photo arrays by
    // ascending resolution, so the last entry with a file_id is the largest
    // variant we can actually download.
    let largest: any = sized
    if (!largest) {
      for (let i = photo.length - 1; i >= 0; i--) {
        const p = photo[i]
        if (!p || typeof p !== "object") continue
        if (!p.file_id) continue
        largest = p
        break
      }
    }

    if (largest?.file_id) {
      out.push({
        kind: "photo",
        fileId: String(largest.file_id),
        mimeType: DEFAULT_MIME_BY_KIND.photo,
        size: typeof largest.file_size === "number" ? largest.file_size : undefined,
      })
    }
  }

  // Single-object kinds
  const singleKinds: Array<{
    key: string
    kind: TelegramAttachmentKind
    useFileName: boolean
  }> = [
    { key: "document", kind: "document", useFileName: true },
    { key: "video", kind: "video", useFileName: true },
    { key: "video_note", kind: "video_note", useFileName: false },
    { key: "audio", kind: "audio", useFileName: true },
    { key: "voice", kind: "voice", useFileName: false },
    { key: "animation", kind: "animation", useFileName: true },
    { key: "sticker", kind: "sticker", useFileName: false },
  ]

  for (const { key, kind, useFileName } of singleKinds) {
    const value = message[key] as Record<string, unknown> | undefined
    if (!value || typeof value !== "object" || !value.file_id) continue
    const att: TelegramAttachment = {
      kind,
      fileId: String(value.file_id),
      mimeType:
        typeof value.mime_type === "string"
          ? value.mime_type
          : DEFAULT_MIME_BY_KIND[kind],
      size: typeof value.file_size === "number" ? value.file_size : undefined,
    }
    if (useFileName && typeof value.file_name === "string") {
      att.fileName = value.file_name
    }
    out.push(att)
  }

  return out
}

/**
 * A file attachment that has been downloaded to a local path under the
 * session's working directory. The connector exposes these paths to the
 * LLM so it can read them with shell/Read/Glob tools.
 */
export interface DownloadedAttachment {
  localPath: string
  /** Basename of `localPath` -- same as `path.basename(localPath)` but cached. */
  fileName: string
  mimeType: string
  size: number
  kind: TelegramAttachmentKind
}

// =============================================================================
// Session type
// =============================================================================

interface ChatSession extends BaseSession {}

// =============================================================================
// Telegram Connector
// =============================================================================

export class TelegramConnector extends BaseConnector<ChatSession> {
  private botId = 0
  private botUsername = ""
  private offset = 0
  private polling = false
  private pollAbort: AbortController | null = null
  private updateTasks = new Set<Promise<void>>()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 20
  private threadIsolation: boolean
  private respondToMentions: boolean
  private respondToReplies: boolean

  constructor() {
    super({
      connector: "telegram",
      trigger: TRIGGER,
      botName: BOT_NAME,
      rateLimitSeconds: RATE_LIMIT_SECONDS,
      sessionRetentionDays: SESSION_RETENTION_DAYS,
      allowedUsers: ALLOWED_USERS,
    })
    this.threadIsolation = THREAD_ISOLATION
    this.respondToMentions = config.telegram.respondToMentions
    this.respondToReplies = config.telegram.respondToReplies
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (!TG_TOKEN) {
      console.error("Error: TELEGRAM_BOT_TOKEN not set")
      console.error("Create a bot via @BotFather in Telegram and copy the token")
      process.exit(1)
    }

    this.log("Starting...")
    this.logStartup()
    console.log(`  Thread isolation: ${this.threadIsolation ? "on (per-topic sessions)" : "off (per-chat sessions)"}`)
    console.log(`  Respond to mentions: ${this.respondToMentions ? "on" : "off"}`)
    console.log(`  Respond to replies: ${this.respondToReplies ? "on" : "off"}`)
    if (DROP_PENDING) console.log(`  Will drop pending updates on startup`)

    await this.cleanupSessions()

    // Authenticate
    let me: { id: number; username?: string; first_name: string }
    try {
      me = await tgApi<{ id: number; username?: string; first_name: string }>("getMe")
    } catch (err) {
      this.logError("Failed to authenticate with Telegram (check TELEGRAM_BOT_TOKEN):", err)
      process.exit(1)
    }
    this.botId = me.id
    this.botUsername = me.username || me.first_name || "bot"
    console.log(`  Bot: @${this.botUsername} (id=${this.botId})`)

    // Clear any conflicting webhook so getUpdates is the source of truth
    try {
      await tgApi("deleteWebhook", { drop_pending_updates: DROP_PENDING })
      console.log(`  Webhook cleared${DROP_PENDING ? " (dropped pending updates)" : ""}`)
    } catch (err) {
      this.logError("Failed to clear webhook (continuing):", err)
    }

    // If asked to drop backlog, consume one batch with timeout=0 and advance
    // the offset so the very next call skips already-queued messages.
    if (DROP_PENDING) {
      try {
        const updates = await tgApi<Array<{ update_id: number }>>("getUpdates", {
          timeout: 0,
          allowed_updates: ["message"],
        })
        if (updates.length > 0) {
          this.offset = Math.max(...updates.map((u) => u.update_id)) + 1
          console.log(`  Dropped ${updates.length} pending update(s); offset=${this.offset}`)
        }
      } catch (err) {
        this.logError("Failed to drop pending updates (continuing):", err)
      }
    }

    this.polling = true
    // Run polling in the background; don't await here
    this.pollLoop().catch((err) => this.logError("Polling loop crashed:", err))
    this.startSessionExpiryLoop()
    this.log("Started! Listening for messages...")
  }

  async stop(): Promise<void> {
    this.log("Stopping...")
    this.polling = false
    if (this.pollAbort) {
      this.pollAbort.abort()
      this.pollAbort = null
    }
    await this.disconnectAllSessions()
    this.updateTasks.clear()
    this.log("Stopped.")
  }

  /**
   * Required by BaseConnector. Sends a plain text message to a chat.
   * For the common case inside handleUpdate / processQuery we use
   * sendReply() instead, which can also pin to a forum topic or reply
   * to the originating message.
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    const chunks = this.splitMessage(text, MAX_MESSAGE_LENGTH)
    for (const chunk of chunks) {
      try {
        await tgApi("sendMessage", { chat_id: chatId, text: chunk })
      } catch (err) {
        this.logError(`Failed to send message to ${chatId}:`, err)
      }
    }
  }

  /**
   * Send a reply, pinning to the originating forum topic or replying to the
   * originating message when applicable. Mirrors Mattermost's `sendReply()`.
   *
   * Note: replies are always posted inside the topic the user wrote from
   * (when messageThreadId is set), regardless of `threadIsolation`. That
   * setting only controls SESSION keying -- reply routing is independent
   * because Telegram users expect responses where they asked.
   */
  private async sendReply(context: TelegramEventContext, text: string): Promise<void> {
    const chunks = this.splitMessage(text, MAX_MESSAGE_LENGTH)
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      // The first chunk keeps the reply/reference; later chunks are plain
      const body: Record<string, unknown> = { chat_id: context.chatId, text: chunk }
      if (context.messageThreadId !== null) {
        // Always pin to the originating topic -- otherwise the response
        // would land in the supergroup's general chat root, which is
        // surprising for users navigating a forum.
        body.message_thread_id = context.messageThreadId
      } else if (i === 0 && context.replyToMessageId !== null && !context.isPrivate) {
        body.reply_to_message_id = context.replyToMessageId
      }
      try {
        await tgApi("sendMessage", body)
      } catch (err) {
        this.logError(`Failed to send reply to ${context.sessionId}:`, err)
        // In some topics reply_to_message_id is rejected; retry without it.
        if (body.reply_to_message_id) {
          const retry: Record<string, unknown> = { ...body }
          delete retry.reply_to_message_id
          try {
            await tgApi("sendMessage", retry)
          } catch (err2) {
            this.logError(`Retry without reply_to_message_id also failed:`, err2)
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Long polling
  // ---------------------------------------------------------------------------

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      this.pollAbort = new AbortController()
      try {
        await this.pollOnce(this.pollAbort.signal)
        this.reconnectAttempts = 0
      } catch (err: any) {
        if (err?.name === "AbortError") return
        this.reconnectAttempts++
        // Honour retry_after for 429 too
        let delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
        if (typeof err?.retryAfter === "number") delay = Math.max(delay, err.retryAfter * 1000)
        this.logError(
          `Poll error (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}); retrying in ${delay}ms:`,
          err?.message || err
        )
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          this.logError("Max reconnect attempts reached, exiting")
          process.exit(1)
        }
        await new Promise((resolve) => setTimeout(resolve, delay))
      } finally {
        this.pollAbort = null
      }
    }
  }

  private async pollOnce(signal: AbortSignal): Promise<void> {
    const body: Record<string, unknown> = {
      timeout: POLL_TIMEOUT_SECS,
      // Only process new messages. Edited messages are intentionally ignored
      // because rerunning prompts after edits can duplicate or contradict an
      // already-posted bot response.
      allowed_updates: ["message"],
    }
    if (this.offset) body.offset = this.offset

    const res = await fetch(`${TG_API_BASE}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })

    if (!res.ok) {
      throw await telegramHttpError(res, "Telegram getUpdates")
    }
    const json = (await res.json()) as TelegramApiResponse<Array<Record<string, unknown>>>
    if (!json.ok) {
      throw new TelegramApiError(
        json.description || "getUpdates failed",
        json.error_code,
        json.parameters?.retry_after
      )
    }

    const updates = json.result || []
    for (const update of updates) {
      // Advance offset monotonically as soon as Telegram has delivered the
      // update. Processing is dispatched asynchronously below so a slow
      // OpenCode turn in one chat/topic does not block long-polling for every
      // other chat. This keeps the same at-most-once behavior as before: once
      // an update is received, it will not be requested again after restart.
      const id = (update as { update_id?: number }).update_id
      if (typeof id === "number" && id + 1 > this.offset) {
        this.offset = id + 1
      }
      this.dispatchUpdate(update)
    }
  }

  private dispatchUpdate(update: Record<string, unknown>): void {
    let task: Promise<void>
    task = this.handleUpdate(update)
      .catch((err) => {
        this.logError("Error processing update:", err)
      })
      .finally(() => {
        this.updateTasks.delete(task)
      })
    this.updateTasks.add(task)
  }

  // ---------------------------------------------------------------------------
  // Event handling
  // ---------------------------------------------------------------------------

  private async handleUpdate(update: Record<string, unknown>): Promise<void> {
    const message = update.message as Record<string, unknown> | undefined
    if (!message) return

    // Skip bot-authored messages (defensive -- getUpdates typically does not
    // echo back our own messages, but other bots in the chat will deliver)
    const from = (message.from as Record<string, unknown> | undefined) || {}
    if (from.is_bot === true) return

    const chat = (message.chat as Record<string, unknown> | undefined)
    if (!chat || chat.id === undefined) return

    const replyToMessage = message.reply_to_message as
      | { message_id: number; from?: Record<string, unknown> }
      | undefined
    const replyToMessageFromRaw = replyToMessage?.from as
      | { id?: number | string; is_bot?: boolean; username?: string; first_name?: string }
      | undefined
    const replyToMessageFrom =
      replyToMessageFromRaw && replyToMessageFromRaw.id !== undefined
        ? {
            id: replyToMessageFromRaw.id,
            is_bot: replyToMessageFromRaw.is_bot,
            username: replyToMessageFromRaw.username,
            first_name: replyToMessageFromRaw.first_name,
          }
        : undefined

    const ctx = normalizeTelegramEventContext(
      {
        chat: chat as { id: number | string; type: string; is_forum?: boolean },
        from: from as { id: number | string; is_bot?: boolean; username?: string; first_name?: string },
        messageId: Number(message.message_id),
        text: String(message.text || message.caption || ""),
        is_topic_message: message.is_topic_message as boolean | undefined,
        message_thread_id: message.message_thread_id as number | undefined,
        reply_to_message:
          replyToMessage === undefined
            ? undefined
            : {
                message_id: replyToMessage.message_id,
                from: replyToMessageFrom,
              },
      },
      this.threadIsolation
    )

    // Extract any attachments the user sent alongside (or instead of) text.
    // Pure function -- no network calls yet. We download them later, after
    // auth checks, into the session cwd's `uploads/` subdir.
    const allAttachments = ATTACHMENTS_ENABLED ? extractTelegramAttachments(message) : []
    const attachments = allAttachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
    if (allAttachments.length > attachments.length) {
      this.logError(
        `[ATTACH] Skipping ${allAttachments.length - attachments.length} attachment(s): max ${MAX_ATTACHMENTS_PER_MESSAGE} per message`
      )
    }

    // Skip messages with neither text nor attachments. The previous behaviour
    // dropped caption-less media entirely; now we still drop them unless the
    // user attached at least one file.
    if (!ctx.text && attachments.length === 0) return

    // Dedupe (getUpdates occasionally replays at the same offset)
    if (this.isDuplicateEvent(ctx.dedupeId)) return

    // Allowlist + ignore lists
    if (!this.isUserAllowed(ctx.userId)) return
    const ignoreChats = config.telegram.ignoreChats || []
    const ignoreUsers = config.telegram.ignoreUsers || []
    if (ignoreChats.includes(ctx.chatId) || ignoreChats.includes(ctx.userId)) return
    if (ignoreUsers.includes(ctx.userId)) return

    const senderName =
      [from.first_name, from.username].filter(Boolean).join("@") ||
      String(from.id || ctx.userId)
    this.log(
      `[MSG] ${senderName} in ${ctx.sessionId}: ${ctx.text || "(no text)"}${attachments.length > 0 ? ` [${attachments.length} attachment(s)]` : ""}`
    )

    // Resolve the query based on trigger / mention / DM / implicit topic reply.
    // Attachments alone don't bypass the trigger requirement in plain groups
    // (a user can share a photo with a friend without wanting the bot's take),
    // but they DO count as engagement in DMs and inside active forum topics.
    const mention = `@${this.botUsername}`
    const text = ctx.text
    let query = ""

    const isReplyToThisBot =
      this.respondToReplies &&
      ctx.replyToMessageIsBot &&
      ctx.replyToMessageFromId === String(this.botId)

    const canBypassTriggerForAttachments =
      attachments.length > 0 &&
      (ctx.isPrivate ||
        (this.threadIsolation &&
          ctx.messageThreadId !== null &&
          this.sessionManager.has(ctx.sessionId)) ||
        (isReplyToThisBot && this.sessionManager.has(ctx.sessionId)))

    if (text.startsWith(TRIGGER + " ")) {
      query = text.slice(TRIGGER.length + 1).trim()
    } else if (text === TRIGGER) {
      query = ""
    } else if (text.startsWith(TRIGGER)) {
      query = text.slice(TRIGGER.length).trim()
    } else if (
      this.respondToMentions &&
      text.startsWith(mention + " ")
    ) {
      query = text.slice(mention.length + 1).trim()
    } else if (this.respondToMentions && text === mention) {
      query = ""
    } else if (this.respondToMentions && text.startsWith(mention)) {
      query = text.slice(mention.length).trim()
    } else if (ctx.isPrivate) {
      query = text
    } else if (
      this.threadIsolation &&
      shouldHandleImplicitTopicReply({
        text,
        isPrivate: false,
        messageThreadId: ctx.messageThreadId,
        trigger: TRIGGER,
        botUsername: this.botUsername,
      }) &&
      this.sessionManager.has(ctx.sessionId)
    ) {
      // Implicit follow-up inside an active topic
      query = text
    } else if (
      this.respondToReplies &&
      shouldHandleTelegramBotReply({
        enabled: true,
        text,
        isPrivate: ctx.isPrivate,
        replyToMessageIsBot: ctx.replyToMessageIsBot,
        replyToMessageFromId: ctx.replyToMessageFromId,
        ourBotId: this.botId,
      }) &&
      this.sessionManager.has(ctx.sessionId)
    ) {
      // Direct swipe-reply to one of this bot's own messages inside an
      // active chat/topic. DMs are already caught above; this branch is
      // effectively the non-DM reply-to-bot case. Attachment-only replies
      // are handled by the attachment bypass below because this helper
      // requires non-empty text.
      query = text
    } else if (canBypassTriggerForAttachments) {
      // Caption-less attachment in a DM or an active topic -- treat as an
      // attachment-only query (text stays empty; we'll synthesise a header
      // from the downloaded files below).
      query = ""
    } else {
      return
    }

    // Download any attachments to the session cwd BEFORE processing so the
    // LLM can reference them as plain file paths (and so command forwarding
    // also sees them). Failures are logged but never block the query --
    // Telegram Bot API downloads are capped at MAX_DOWNLOAD_BYTES per file.
    const downloadedAttachments: DownloadedAttachment[] =
      attachments.length > 0
        ? await this.downloadAttachmentsToSession(ctx.sessionId, attachments)
        : []

    // Snapshot the original query before we possibly augment it with an
    // `[Attached file: ...]` header. We need this to keep command routing
    // correct: a "/status" caption with an attached photo should still hit
    // the bridge-local command handler, not the OpenCode prompt path.
    const originalQuery = query

    // Prepend attachment info so the LLM can use shell/read tools to access
    // them. If the user sent only a file (no caption), synthesise a minimal
    // body so OpenCode still receives a valid user turn.
    if (downloadedAttachments.length > 0) {
      const header = downloadedAttachments
        .map((d) =>
          `[Attached file: ${d.localPath} (${d.mimeType}, ${d.size} bytes, ${d.kind}, filename="${d.fileName}")]`
        )
        .join("\n")
      if (query) {
        query = `${header}\n\n${query}`
      } else {
        query = `${header}\n\n(User sent a file attachment with no message text. Use the attached tool(s) to examine it.)`
      }
    }

    await this.stopMirrorForUserActivity(ctx.sessionId, query, async (txt) => {
      await this.sendReply(ctx, txt)
    })

    // Bridge-local commands
    if (originalQuery.startsWith("/")) {
      const cmdName = originalQuery.slice(1).split(" ")[0].toLowerCase()
      if (["status", "clear", "reset", "help", "h", "p", "projects", "s", "sessions", "m", "mirror", "r", "reload", "d", "detach"].includes(cmdName)) {
        const session = this.sessionManager.get(ctx.sessionId)
        const openCodeCommands = session?.client.availableCommands || []
        await this.handleCommand(
          ctx.sessionId,
          originalQuery,
          async (txt) => {
            await this.sendReply(ctx, txt)
          },
          { openCodeCommands }
        )
        return
      }

      // Forward other /commands (e.g. /init, /compact) to OpenCode. We pass
      // the AUGMENTED query so the LLM still sees any attached files.
      this.log(`[CMD] Forwarding to OpenCode: ${originalQuery}`)
      if (!this.checkRateLimit(ctx.userId)) return
      await this.processQuery(ctx, query)
      return
    }

    // If user just pinged with no query, give a hint instead of consuming
    // a query slot. By this point `query` is non-empty whenever the user
    // sent at least one attachment, so the hint only fires for plain pings.
    if (!query) {
      if (!ctx.isPrivate) {
        await this.sendReply(
          ctx,
          `Hello! Use \`${TRIGGER}\` to ask me anything, e.g. \`${TRIGGER} what's the weather?\``
        )
      }
      return
    }

    if (!this.checkRateLimit(ctx.userId)) return
    this.log(`[QUERY] ${ctx.sessionId}: ${query}`)
    await this.processQuery(ctx, query)
  }

  // ---------------------------------------------------------------------------
  // Query processing
  // ---------------------------------------------------------------------------

  private async processQuery(context: TelegramEventContext, query: string): Promise<void> {
    const startTime = Date.now()

    // Best-effort typing indicator (do not await; ignore failures)
    this.sendChatAction(context, "typing").catch(() => {})

    // Guard against concurrent queries on the same session
    if (this.isQueryActive(context.sessionId)) {
      await this.sendReply(context, "A request is already running. Please wait for it to finish.")
      return
    }

    // Mark active and ensure the handle is cleared in `finally` so a
    // session-creation failure cannot leave the session permanently
    // reporting "A request is already running" until restart.
    const activeQuery = this.markQueryActive(context.sessionId)

    try {
      const session = await this.getOrCreateSession(context.sessionId, (client) =>
        this.createSession(client)
      )
      if (!session) {
        await this.sendReply(context, CommandHandler.formatConnectionErrorMessage())
        return
      }

      session.messageCount++
      session.lastActivity = new Date()
      session.inputChars += query.length

      const client = session.client

      let responseBuffer = ""
      let toolResultsBuffer = ""
      let lastActivityMessage = ""
      let toolCallCount = 0
      const sentToolOutputs = new Set<string>()

      const activityHandler = async (activity: ActivityEvent) => {
        if (activity.type === "tool_start") {
          toolCallCount++
          const message = formatToolCallMessage(activity, config.toolMessages)
          if (message && message !== lastActivityMessage) {
            lastActivityMessage = message
            await this.sendReply(context, `> ${message}`)
          }
        }
      }
      const chunkHandler = (text: string) => {
        responseBuffer += text
      }
      const updateHandler = async (update: any) => {
        if (update.type === "tool_result" && update.toolResult) {
          toolResultsBuffer += update.toolResult

          const toolName = update.toolName || ""
          const shouldShow = shouldShowToolOutput(toolName, config.toolMessages)
          if (!shouldShow) return

          const maxLen = 2000
          const result =
            update.toolResult.length > maxLen
              ? update.toolResult.slice(0, maxLen) + "\n... (truncated)"
              : update.toolResult
          const trimmed = result.trim()
          if (!trimmed) return

          const hash = trimmed.slice(0, 100)
          if (sentToolOutputs.has(hash)) return
          sentToolOutputs.add(hash)
          try {
            await this.sendReply(context, trimmed)
          } catch (err) {
            this.log(`[RESULT] Error sending: ${err}`)
          }
        }

        // Stream partial tool output
        if (update.type === "tool_output_delta" && update.partialOutput) {
          const toolName = update.toolName || ""
          const shouldStream = shouldShowToolOutput(toolName, config.toolMessages)
          if (!shouldStream) return

          const output = update.partialOutput.trim()
          if (!output) return
          const hash = output.slice(0, 100)
          if (sentToolOutputs.has(hash)) return
          sentToolOutputs.add(hash)
          await this.sendReply(context, output)
          this.log(`[STREAM] Sent ${toolName} output (${output.length} chars)`)
        }
      }
      const imageHandler = async (image: ImageContent) => {
        this.log(`Received image: ${image.mimeType}`)
      }
      const permissionHandler = async (event: {
        permission: string
        path: string | null
        message: string
      }) => {
        this.log(`[PERMISSION] Rejected: ${event.permission}${event.path ? ` (${event.path})` : ""}`)
        await this.sendReply(context, `> ${event.message}`)
      }

      client.on("activity", activityHandler)
      client.on("chunk", chunkHandler)
      client.on("update", updateHandler)
      client.on("image", imageHandler)
      client.on("permission_rejected", permissionHandler)

      try {
        await client.prompt(query)

        // Images from tool results (primary)
        const uploadedPaths = new Set<string>()
        const toolImagePaths = extractImagePaths(toolResultsBuffer)
        for (const imagePath of toolImagePaths) {
          if (fs.existsSync(imagePath)) {
            this.log(`Uploading image from tool result: ${imagePath}`)
            await this.sendPhotoFromFile(context, imagePath)
            uploadedPaths.add(imagePath)
          }
        }
        // Images echoed in the response
        const responseImagePaths = extractImagePaths(responseBuffer)
        for (const imagePath of responseImagePaths) {
          if (uploadedPaths.has(imagePath)) continue
          if (fs.existsSync(imagePath)) {
            this.log(`Uploading image from response: ${imagePath}`)
            await this.sendPhotoFromFile(context, imagePath)
          }
        }

        // Documents from tool results
        const uploadedDocs = new Set<string>()
        const toolDocPaths = extractDocPaths(toolResultsBuffer)
        for (const docPath of toolDocPaths) {
          if (fs.existsSync(docPath)) {
            this.log(`Uploading document from tool result: ${docPath}`)
            await this.sendDocumentFromFile(context, docPath)
            uploadedDocs.add(docPath)
          }
        }
        // Documents echoed in the response
        const responseDocPaths = extractDocPaths(responseBuffer)
        for (const docPath of responseDocPaths) {
          if (uploadedDocs.has(docPath)) continue
          if (fs.existsSync(docPath)) {
            this.log(`Uploading document from response: ${docPath}`)
            await this.sendDocumentFromFile(context, docPath)
          }
        }

        // Final cleaned response
        const cleanResponse = sanitizeServerPaths(
          removeDocMarkers(removeImageMarkers(responseBuffer))
        )
        if (cleanResponse) {
          session.outputChars += cleanResponse.length
          await this.sendReply(context, cleanResponse)
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        const outChars = cleanResponse ? cleanResponse.length : 0
        const tools = toolCallCount > 0 ? `, ${toolCallCount} tool${toolCallCount > 1 ? "s" : ""}` : ""
        this.log(`[DONE] ${elapsed}s (${outChars} chars${tools}) [${context.sessionId}]`)
      } catch (err) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        this.logError(`[FAIL] ${elapsed}s [${context.sessionId}]:`, err)
        await this.sendReply(context, CommandHandler.formatProcessingErrorMessage())
      } finally {
        client.off("activity", activityHandler)
        client.off("chunk", chunkHandler)
        client.off("update", updateHandler)
        client.off("image", imageHandler)
        client.off("permission_rejected", permissionHandler)
        if (session) session.lastActivity = new Date()
        // markQueryDone is intentionally not called here -- the outer
        // finally below is the single source of truth so it always runs,
        // even on session-creation failure.
      }
    } finally {
      this.markQueryDone(context.sessionId, activeQuery)
    }
  }

  private createSession(client: ACPClient): ChatSession {
    return { ...this.createBaseSession(client) }
  }

  // ---------------------------------------------------------------------------
  // Media uploads
  // ---------------------------------------------------------------------------

  /**
   * Resolve the per-session `uploads/` directory and download every user-sent
   * attachment into it. Returns the list of local paths actually downloaded;
   * failures (oversized files, network errors) are logged and skipped so the
   * LLM only sees files that succeeded.
   *
   * Must be called BEFORE `getOrCreateSession()` would create the session cwd
   * so that `ensureSessionDir(sessionDir)` is a no-op when the connector
   * subsequently copies its config and starts OpenCode there.
   */
  private async downloadAttachmentsToSession(
    sessionId: string,
    attachments: TelegramAttachment[]
  ): Promise<DownloadedAttachment[]> {
    if (attachments.length === 0) return []

    let sessionDir: string
    let uploadsDir: string
    try {
      sessionDir = getSessionDir("telegram", sessionId)
      uploadsDir = path.join(sessionDir, UPLOADS_SUBDIR)
      ensureSessionDir(uploadsDir) // also ensures sessionDir
    } catch (err) {
      this.logError(`[ATTACH] Failed to prepare uploads dir for ${sessionId}:`, err)
      return []
    }

    const downloaded: DownloadedAttachment[] = []

    for (const att of attachments) {
      try {
        if (att.size !== undefined && att.size > MAX_DOWNLOAD_BYTES) {
          this.logError(
            `[ATTACH] Skipping ${att.kind} ${att.fileId}: ${att.size} bytes exceeds ${MAX_DOWNLOAD_BYTES}-byte Telegram download limit`
          )
          continue
        }

        const fileInfo = await tgApi<{
          file_id: string
          file_unique_id: string
          file_size?: number
          file_path?: string
        }>("getFile", { file_id: att.fileId })

        if (!fileInfo?.file_path) {
          this.logError(`[ATTACH] getFile returned no file_path for ${att.kind} ${att.fileId}`)
          continue
        }

        const basename = buildAttachmentFilename(att, fileInfo.file_path)
        const localPath = path.join(uploadsDir, basename)

        const size = await tgDownloadFile(fileInfo.file_path, localPath)

        downloaded.push({
          localPath,
          fileName: basename,
          mimeType: att.mimeType || DEFAULT_MIME_BY_KIND[att.kind],
          size,
          kind: att.kind,
        })
        this.log(`[ATTACH] Downloaded ${att.kind} -> ${localPath} (${size} bytes)`)
      } catch (err) {
        this.logError(`[ATTACH] Failed to download ${att.kind} ${att.fileId}:`, err)
      }
    }

    return downloaded
  }

  private async sendPhotoFromFile(context: TelegramEventContext, filePath: string): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        this.logError(`Image not found: ${filePath}`)
        return
      }
      const fields: Record<string, string> = { chat_id: context.chatId }
      if (context.messageThreadId !== null) {
        fields.message_thread_id = String(context.messageThreadId)
      }
      await tgUpload("sendPhoto", fields, filePath, "photo")
      this.log(`Sent photo to ${context.sessionId}: ${path.basename(filePath)}`)
    } catch (err) {
      this.logError(`Failed to send photo to ${context.sessionId}:`, err)
    }
  }

  private async sendDocumentFromFile(context: TelegramEventContext, filePath: string): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        this.logError(`Document not found: ${filePath}`)
        return
      }
      const fields: Record<string, string> = { chat_id: context.chatId }
      if (context.messageThreadId !== null) {
        fields.message_thread_id = String(context.messageThreadId)
      }
      await tgUpload("sendDocument", fields, filePath, "document")
      this.log(`Sent document to ${context.sessionId}: ${path.basename(filePath)}`)
    } catch (err) {
      this.logError(`Failed to send document to ${context.sessionId}:`, err)
    }
  }

  // ---------------------------------------------------------------------------
  // Chat actions / helpers
  // ---------------------------------------------------------------------------

  private async sendChatAction(context: TelegramEventContext, action: string): Promise<void> {
    try {
      const body: Record<string, unknown> = { chat_id: context.chatId, action }
      if (context.messageThreadId !== null) {
        body.message_thread_id = context.messageThreadId
      }
      await tgApi("sendChatAction", body)
    } catch {
      // typing indicator is best-effort
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > maxLen) {
      let splitAt = remaining.lastIndexOf("\n", maxLen)
      if (splitAt <= 0) splitAt = maxLen
      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).trimStart()
    }
    if (remaining) chunks.push(remaining)
    return chunks
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const connector = new TelegramConnector()
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
