/**
 * Integration tests for Telegram event-to-context mapping.
 *
 * Exercises full Telegram update payloads (raw shapes from getUpdates) and
 * exercises the pure helpers together so the cross-connector invariants
 * (sessionId, dedupeId, replyToMessageId, messageThreadId) stay coherent.
 */

import { describe, test, expect } from "bun:test"
import {
  normalizeTelegramEventContext,
  buildTelegramSessionId,
  resolveMessageThreadId,
  type TelegramEventContext,
} from "../../connectors/telegram"

/** Build a raw Telegram update-shape payload -- mirrors what getUpdates delivers. */
function tgUpdate(opts: {
  chatId: number | string
  chatType?: string
  isForum?: boolean
  from: number | string
  username?: string
  firstName?: string
  messageId: number
  text?: string
  caption?: string
  isTopicMessage?: boolean
  messageThreadId?: number
  replyToMessageId?: number
  isBot?: boolean
  updateId?: number
}): Record<string, unknown> {
  const chat: Record<string, unknown> = {
    id: opts.chatId,
    type: opts.chatType ?? "supergroup",
  }
  if (opts.isForum) chat.is_forum = true

  const from: Record<string, unknown> = {
    id: opts.from,
    is_bot: !!opts.isBot,
  }
  if (opts.username) from.username = opts.username
  if (opts.firstName) from.first_name = opts.firstName

  const message: Record<string, unknown> = {
    message_id: opts.messageId,
    from,
    chat,
    date: 1_700_000_000,
  }
  if (opts.text !== undefined) message.text = opts.text
  if (opts.caption !== undefined) message.caption = opts.caption
  if (opts.isTopicMessage) message.is_topic_message = true
  if (opts.messageThreadId !== undefined) message.message_thread_id = opts.messageThreadId
  if (opts.replyToMessageId !== undefined) {
    message.reply_to_message = { message_id: opts.replyToMessageId }
  }

  return {
    update_id: opts.updateId ?? opts.messageId,
    message,
  }
}

/** Run a raw update payload through our normalizer (mirrors handleUpdate's call). */
function map(raw: Record<string, unknown>, threadIsolation = true): TelegramEventContext {
  const message = raw.message as Record<string, unknown>
  const chat = message.chat as { id: number | string; type: string; is_forum?: boolean }
  const from = message.from as { id: number | string; is_bot?: boolean; username?: string; first_name?: string }

  return normalizeTelegramEventContext(
    {
      chat,
      from,
      messageId: Number(message.message_id),
      text: String(message.text || message.caption || ""),
      is_topic_message: message.is_topic_message as boolean | undefined,
      message_thread_id: message.message_thread_id as number | undefined,
      reply_to_message: message.reply_to_message as { message_id: number } | undefined,
    },
    threadIsolation
  )
}

describe("telegram event mapping integration", () => {
  test("forum-topic trigger maps to chatId:threadId session", () => {
    const ctx = map(
      tgUpdate({
        chatId: -1001,
        isForum: true,
        from: 42,
        messageId: 100,
        text: "!oc summarize this topic",
        isTopicMessage: true,
        messageThreadId: 7,
      })
    )
    expect(ctx.sessionId).toBe("-1001:7")
    expect(ctx.isForumTopic).toBe(true)
    expect(ctx.messageThreadId).toBe(7)
    expect(ctx.dedupeId).toBe("-1001:100")
    expect(ctx.replyToMessageId).toBeNull()
  })

  test("two forum topics in the same chat get isolated sessions", () => {
    const a = map(
      tgUpdate({
        chatId: -1001,
        isForum: true,
        from: 42,
        messageId: 1,
        text: "x",
        isTopicMessage: true,
        messageThreadId: 5,
      })
    )
    const b = map(
      tgUpdate({
        chatId: -1001,
        isForum: true,
        from: 42,
        messageId: 2,
        text: "y",
        isTopicMessage: true,
        messageThreadId: 6,
      })
    )
    expect(a.sessionId).toBe("-1001:5")
    expect(b.sessionId).toBe("-1001:6")
    expect(a.sessionId).not.toBe(b.sessionId)
  })

  test("plain message in non-forum supergroup maps to chatId", () => {
    const ctx = map(
      tgUpdate({
        chatId: -1001,
        isForum: false,
        from: 1,
        messageId: 10,
        text: "!oc hi",
      })
    )
    expect(ctx.messageThreadId).toBeNull()
    expect(ctx.sessionId).toBe("-1001")
    expect(ctx.isForumTopic).toBe(false)
  })

  test("DM: every message routes to the same per-user chatId", () => {
    const a = map(
      tgUpdate({
        chatId: 99,
        chatType: "private",
        from: 42,
        messageId: 1,
        text: "!oc hi",
      })
    )
    const b = map(
      tgUpdate({
        chatId: 99,
        chatType: "private",
        from: 42,
        messageId: 2,
        text: "!oc follow up",
      })
    )
    expect(a.sessionId).toBe("99")
    expect(b.sessionId).toBe("99")
    expect(a.dedupeId).toBe("99:1")
    expect(b.dedupeId).toBe("99:2")
  })

  test("caption is used when text is absent", () => {
    const ctx = map(
      tgUpdate({
        chatId: 99,
        chatType: "private",
        from: 42,
        messageId: 5,
        caption: "!oc what's in this photo?",
      })
    )
    expect(ctx.text).toBe("!oc what's in this photo?")
  })

  test("reply_to_message_id is preserved for visual replies", () => {
    const ctx = map(
      tgUpdate({
        chatId: -1001,
        isForum: false,
        from: 42,
        messageId: 200,
        text: "!oc explain",
        replyToMessageId: 199,
      })
    )
    expect(ctx.replyToMessageId).toBe(199)
    expect(ctx.sessionId).toBe("-1001")
    expect(ctx.messageThreadId).toBeNull()
  })

  test("threadIsolation off collapses all topics in a chat to one session", () => {
    const a = map(
      tgUpdate({
        chatId: -1001,
        isForum: true,
        from: 42,
        messageId: 1,
        text: "x",
        isTopicMessage: true,
        messageThreadId: 5,
      }),
      false
    )
    const b = map(
      tgUpdate({
        chatId: -1001,
        isForum: true,
        from: 42,
        messageId: 2,
        text: "y",
        isTopicMessage: true,
        messageThreadId: 6,
      }),
      false
    )
    expect(a.sessionId).toBe(b.sessionId)
    expect(a.sessionId).toBe("-1001")
    // messageThreadId is always preserved on the context. The connector
    // uses it to pin replies to the originating topic regardless of
    // threadIsolation; threadIsolation only controls how the session key
    // is derived (chatId vs chatId:messageThreadId).
    expect(a.messageThreadId).toBe(5)
    expect(b.messageThreadId).toBe(6)
  })

  test("dedupe IDs are unique across chats and messages", () => {
    const a = map(
      tgUpdate({ chatId: 1, chatType: "private", from: 1, messageId: 1, text: "hi" })
    )
    const b = map(
      tgUpdate({ chatId: 2, chatType: "private", from: 1, messageId: 1, text: "hi" })
    )
    expect(a.dedupeId).toBe("1:1")
    expect(b.dedupeId).toBe("2:1")
    expect(a.dedupeId).not.toBe(b.dedupeId)
  })

  test("build / resolve / normalize are mutually consistent", () => {
    // Round-trip: take a raw payload, normalize, then re-derive sessionId
    // the same way buildTelegramSessionId does internally.
    const raw = tgUpdate({
      chatId: -1009,
      isForum: true,
      from: 7,
      messageId: 11,
      text: "!oc go",
      isTopicMessage: true,
      messageThreadId: 99,
    })
    const ctx = map(raw, true)
    const expectedSession = buildTelegramSessionId(
      ctx.chatId,
      resolveMessageThreadId({
        is_topic_message: raw.message?.is_topic_message as boolean | undefined,
        message_thread_id: raw.message?.message_thread_id as number | undefined,
      }),
      true
    )
    expect(ctx.sessionId).toBe(expectedSession)
    expect(ctx.sessionId).toBe("-1009:99")
  })
})
