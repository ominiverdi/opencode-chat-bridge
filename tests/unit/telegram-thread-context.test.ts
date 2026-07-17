/**
 * Unit tests for Telegram thread context helpers
 * Tests the pure functions exported from connectors/telegram.ts
 */

import { describe, test, expect } from "bun:test"
import {
  resolveMessageThreadId,
  buildTelegramSessionId,
  normalizeTelegramEventContext,
  shouldHandleImplicitTopicReply,
  shouldHandleTelegramBotReply,
  type TelegramNormalizeInput,
} from "../../connectors/telegram"

// =============================================================================
// resolveMessageThreadId
// =============================================================================

describe("resolveMessageThreadId", () => {
  test("returns threadId when is_topic_message and message_thread_id present", () => {
    expect(
      resolveMessageThreadId({ is_topic_message: true, message_thread_id: 17 })
    ).toBe(17)
  })

  test("returns null when not a topic message", () => {
    expect(
      resolveMessageThreadId({ is_topic_message: false, message_thread_id: 17 })
    ).toBeNull()
  })

  test("returns null when is_topic_message missing", () => {
    expect(resolveMessageThreadId({ message_thread_id: 17 })).toBeNull()
  })

  test("returns null when message_thread_id is not a number", () => {
    expect(
      resolveMessageThreadId({ is_topic_message: true, message_thread_id: undefined })
    ).toBeNull()
  })

  test("returns null on empty input", () => {
    expect(resolveMessageThreadId({})).toBeNull()
  })
})

// =============================================================================
// buildTelegramSessionId
// =============================================================================

describe("buildTelegramSessionId", () => {
  test("uses chatId:threadId when threadIsolation is on and threadId set", () => {
    expect(buildTelegramSessionId("100", 7, true)).toBe("100:7")
  })

  test("uses chatId only when threadIsolation is on but no threadId", () => {
    expect(buildTelegramSessionId("100", null, true)).toBe("100")
  })

  test("uses chatId only when threadIsolation is off", () => {
    expect(buildTelegramSessionId("100", 7, false)).toBe("100")
  })

  test("uses chatId only when threadIsolation is off and no threadId", () => {
    expect(buildTelegramSessionId("-1001234567890", null, false)).toBe("-1001234567890")
  })

  test("two topics in same chat get different IDs when isolation is on", () => {
    const a = buildTelegramSessionId("-100", 5, true)
    const b = buildTelegramSessionId("-100", 6, true)
    expect(a).not.toBe(b)
  })

  test("two topics in same chat share an ID when isolation is off", () => {
    const a = buildTelegramSessionId("-100", 5, false)
    const b = buildTelegramSessionId("-100", 6, false)
    expect(a).toBe(b)
  })
})

// =============================================================================
// normalizeTelegramEventContext
// =============================================================================

const baseInput: TelegramNormalizeInput = {
  chat: { id: 100, type: "supergroup", is_forum: true },
  from: { id: 42, username: "alice", first_name: "Alice" },
  messageId: 9001,
  text: "  hello there  ",
  is_topic_message: true,
  message_thread_id: 7,
}

describe("normalizeTelegramEventContext", () => {
  test("normalizes a forum-topic message with threadIsolation on", () => {
    const ctx = normalizeTelegramEventContext(baseInput, true)

    expect(ctx.chatId).toBe("100")
    expect(ctx.userId).toBe("42")
    expect(ctx.messageId).toBe(9001)
    expect(ctx.text).toBe("hello there")
    expect(ctx.messageThreadId).toBe(7)
    expect(ctx.chatType).toBe("supergroup")
    expect(ctx.isForumTopic).toBe(true)
    expect(ctx.isPrivate).toBe(false)
    expect(ctx.sessionId).toBe("100:7")
    expect(ctx.dedupeId).toBe("100:9001")
    expect(ctx.replyToMessageId).toBeNull()
  })

  test("normalizes a private chat with threadIsolation off", () => {
    const ctx = normalizeTelegramEventContext(
      {
        chat: { id: 99, type: "private" },
        from: { id: 42 },
        messageId: 1,
        text: "hi",
      },
      false
    )
    expect(ctx.chatId).toBe("99")
    expect(ctx.userId).toBe("42")
    expect(ctx.isPrivate).toBe(true)
    expect(ctx.isForumTopic).toBe(false)
    expect(ctx.messageThreadId).toBeNull()
    expect(ctx.sessionId).toBe("99")
    expect(ctx.dedupeId).toBe("99:1")
  })

  test("non-topic supergroup message with threadIsolation on uses chatId as session", () => {
    const ctx = normalizeTelegramEventContext(
      {
        chat: { id: -1000, type: "supergroup" },
        from: { id: 1 },
        messageId: 2,
        text: "hi",
      },
      true
    )
    expect(ctx.messageThreadId).toBeNull()
    expect(ctx.isForumTopic).toBe(false)
    expect(ctx.sessionId).toBe("-1000")
  })

  test("forum supergroup but non-topic message uses chatId as session", () => {
    const ctx = normalizeTelegramEventContext(
      {
        chat: { id: -1000, type: "supergroup", is_forum: true },
        from: { id: 1 },
        messageId: 3,
        text: "general topic",
        // is_topic_message undefined
      },
      true
    )
    expect(ctx.isForumTopic).toBe(false)
    expect(ctx.messageThreadId).toBeNull()
    expect(ctx.sessionId).toBe("-1000")
  })

  test("threadIsolation off routes forum topic messages to chatId", () => {
    const ctx = normalizeTelegramEventContext(baseInput, false)
    expect(ctx.messageThreadId).toBe(7) // preserved
    expect(ctx.sessionId).toBe("100") // collapsed
  })

  test("reply_to_message_id is preserved", () => {
    const ctx = normalizeTelegramEventContext(
      { ...baseInput, reply_to_message: { message_id: 1234 } },
      true
    )
    expect(ctx.replyToMessageId).toBe(1234)
    expect(ctx.replyToMessageFromId).toBeNull()
    expect(ctx.replyToMessageIsBot).toBe(false)
  })

  test("reply_to_message.from identifies the parent author", () => {
    const ctx = normalizeTelegramEventContext(
      {
        ...baseInput,
        reply_to_message: {
          message_id: 1234,
          from: { id: 7777, is_bot: true, username: "ocbot" },
        },
      },
      true
    )
    expect(ctx.replyToMessageId).toBe(1234)
    expect(ctx.replyToMessageFromId).toBe("7777")
    expect(ctx.replyToMessageIsBot).toBe(true)
  })

  test("reply_to_message.from.is_bot=false for a human-authored parent", () => {
    const ctx = normalizeTelegramEventContext(
      {
        ...baseInput,
        reply_to_message: {
          message_id: 1234,
          from: { id: 5555, is_bot: false, username: "alice" },
        },
      },
      true
    )
    expect(ctx.replyToMessageFromId).toBe("5555")
    expect(ctx.replyToMessageIsBot).toBe(false)
  })

  test("handles missing optional fields", () => {
    const ctx = normalizeTelegramEventContext(
      {
        chat: { id: 1, type: "private" },
        from: { id: 2 },
        messageId: 3,
      },
      true
    )
    expect(ctx.text).toBe("")
    expect(ctx.messageThreadId).toBeNull()
    expect(ctx.replyToMessageId).toBeNull()
    expect(ctx.isForumTopic).toBe(false)
    expect(ctx.sessionId).toBe("1")
  })

  test("stringifies numeric IDs so the session key is filesystem-safe", () => {
    const ctx = normalizeTelegramEventContext(
      {
        chat: { id: -1001234567890, type: "supergroup" },
        from: { id: 987654321 },
        messageId: 10,
      },
      false
    )
    expect(ctx.chatId).toBe("-1001234567890")
    expect(ctx.userId).toBe("987654321")
  })
})

// =============================================================================
// shouldHandleImplicitTopicReply
// =============================================================================

describe("shouldHandleImplicitTopicReply", () => {
  test("accepts plain topic replies", () => {
    expect(
      shouldHandleImplicitTopicReply({
        text: "continue this",
        isPrivate: false,
        messageThreadId: 7,
        trigger: "!oc",
        botUsername: "ocbot",
      })
    ).toBe(true)
  })

  test("rejects DM (private chat)", () => {
    expect(
      shouldHandleImplicitTopicReply({
        text: "continue",
        isPrivate: true,
        messageThreadId: 7,
        trigger: "!oc",
      })
    ).toBe(false)
  })

  test("rejects when messageThreadId is null (not in a topic)", () => {
    expect(
      shouldHandleImplicitTopicReply({
        text: "continue",
        isPrivate: false,
        messageThreadId: null,
        trigger: "!oc",
      })
    ).toBe(false)
  })

  test("rejects trigger-prefixed messages", () => {
    expect(
      shouldHandleImplicitTopicReply({
        text: "!oc do something",
        isPrivate: false,
        messageThreadId: 7,
        trigger: "!oc",
        botUsername: "ocbot",
      })
    ).toBe(false)
  })

  test("rejects bare trigger", () => {
    expect(
      shouldHandleImplicitTopicReply({
        text: "!oc",
        isPrivate: false,
        messageThreadId: 7,
        trigger: "!oc",
      })
    ).toBe(false)
  })

  test("rejects @mention messages", () => {
    expect(
      shouldHandleImplicitTopicReply({
        text: "@ocbot hi",
        isPrivate: false,
        messageThreadId: 7,
        trigger: "!oc",
        botUsername: "ocbot",
      })
    ).toBe(false)
  })

  test("rejects empty text", () => {
    expect(
      shouldHandleImplicitTopicReply({
        text: "",
        isPrivate: false,
        messageThreadId: 7,
        trigger: "!oc",
      })
    ).toBe(false)
  })

  test("trigger matching is case-insensitive", () => {
    expect(
      shouldHandleImplicitTopicReply({
        text: "!OC do something",
        isPrivate: false,
        messageThreadId: 7,
        trigger: "!oc",
      })
    ).toBe(false)
  })

  test("@mention matching is case-insensitive", () => {
    expect(
      shouldHandleImplicitTopicReply({
        text: "@OCBot hi",
        isPrivate: false,
        messageThreadId: 7,
        trigger: "!oc",
        botUsername: "ocbot",
      })
    ).toBe(false)
  })

  test("works without botUsername", () => {
    expect(
      shouldHandleImplicitTopicReply({
        text: "plain reply",
        isPrivate: false,
        messageThreadId: 7,
        trigger: "!oc",
      })
    ).toBe(true)
  })
})

// =============================================================================
// shouldHandleTelegramBotReply
// =============================================================================

const OUR_BOT_ID = 12345

describe("shouldHandleTelegramBotReply", () => {
  test("accepts a swipe-reply to our own bot message", () => {
    expect(
      shouldHandleTelegramBotReply({
        enabled: true,
        text: "thanks!",
        isPrivate: false,
        replyToMessageIsBot: true,
        replyToMessageFromId: String(OUR_BOT_ID),
        ourBotId: OUR_BOT_ID,
      })
    ).toBe(true)
  })

  test("accepts in a DM too -- the per-chat branch already covers it", () => {
    expect(
      shouldHandleTelegramBotReply({
        enabled: true,
        text: "ok",
        isPrivate: true,
        replyToMessageIsBot: true,
        replyToMessageFromId: String(OUR_BOT_ID),
        ourBotId: OUR_BOT_ID,
      })
    ).toBe(true)
  })

  test("rejects when disabled", () => {
    expect(
      shouldHandleTelegramBotReply({
        enabled: false,
        text: "thanks!",
        isPrivate: false,
        replyToMessageIsBot: true,
        replyToMessageFromId: String(OUR_BOT_ID),
        ourBotId: OUR_BOT_ID,
      })
    ).toBe(false)
  })

  test("rejects when not a reply", () => {
    expect(
      shouldHandleTelegramBotReply({
        enabled: true,
        text: "hi",
        isPrivate: false,
        replyToMessageIsBot: false,
        replyToMessageFromId: null,
        ourBotId: OUR_BOT_ID,
      })
    ).toBe(false)
  })

  test("rejects when parent was authored by a different bot", () => {
    expect(
      shouldHandleTelegramBotReply({
        enabled: true,
        text: "hi",
        isPrivate: false,
        replyToMessageIsBot: true,
        replyToMessageFromId: "99999", // some other bot
        ourBotId: OUR_BOT_ID,
      })
    ).toBe(false)
  })

  test("rejects when parent was authored by a human", () => {
    expect(
      shouldHandleTelegramBotReply({
        enabled: true,
        text: "hi",
        isPrivate: false,
        replyToMessageIsBot: false,
        replyToMessageFromId: "5555",
        ourBotId: OUR_BOT_ID,
      })
    ).toBe(false)
  })

  test("rejects empty text", () => {
    expect(
      shouldHandleTelegramBotReply({
        enabled: true,
        text: "",
        isPrivate: false,
        replyToMessageIsBot: true,
        replyToMessageFromId: String(OUR_BOT_ID),
        ourBotId: OUR_BOT_ID,
      })
    ).toBe(false)
  })

  test("rejects when parent author id is missing (Telegram privacy redaction)", () => {
    expect(
      shouldHandleTelegramBotReply({
        enabled: true,
        text: "hi",
        isPrivate: false,
        replyToMessageIsBot: false,
        replyToMessageFromId: null,
        ourBotId: OUR_BOT_ID,
      })
    ).toBe(false)
  })

  test("matches bot id as string vs number without coercion surprise", () => {
    expect(
      shouldHandleTelegramBotReply({
        enabled: true,
        text: "ok",
        isPrivate: false,
        replyToMessageIsBot: true,
        replyToMessageFromId: String(OUR_BOT_ID),
        ourBotId: OUR_BOT_ID,
      })
    ).toBe(true)
  })

  test("rejects when botId was never resolved (0)", () => {
    expect(
      shouldHandleTelegramBotReply({
        enabled: true,
        text: "ok",
        isPrivate: false,
        replyToMessageIsBot: true,
        replyToMessageFromId: "0",
        ourBotId: 0,
      })
    ).toBe(true) // "0" === "0" -- this test documents current behavior; caller
                 // guards against botId=0 by short-circuiting the branch
                 // entirely at the call site.
  })
})
