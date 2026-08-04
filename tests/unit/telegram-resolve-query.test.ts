/**
 * Unit tests for the Telegram query-decision helper.
 *
 * The decision tree is exported from connectors/telegram.ts as
 * `resolveTelegramQuery` so we can test the routing rules in isolation,
 * including the `respondToImplicitTopicReplies` flag that gates the
 * implicit-topic-reply branch.
 */

import { describe, test, expect } from "bun:test"
import {
  resolveTelegramQuery,
  type ResolveTelegramQueryInput,
} from "../../connectors/telegram"

const OUR_BOT_ID = 12345
const TRIGGER = "!oc"
const BOT_USERNAME = "ocbot"

function baseInput(overrides: Partial<ResolveTelegramQueryInput> = {}): ResolveTelegramQueryInput {
  return {
    text: "",
    isPrivate: false,
    messageThreadId: null,
    replyToMessageIsBot: false,
    replyToMessageFromId: null,
    trigger: TRIGGER,
    botUsername: BOT_USERNAME,
    ourBotId: OUR_BOT_ID,
    hasAttachments: false,
    hasActiveSession: false,
    respondToMentions: true,
    respondToReplies: true,
    respondToImplicitTopicReplies: true,
    threadIsolation: true,
    ...overrides,
  }
}

// =============================================================================
// Trigger prefix
// =============================================================================

describe("resolveTelegramQuery - trigger prefix", () => {
  test("strips trigger prefix and forwards the rest", () => {
    const r = resolveTelegramQuery(baseInput({ text: "!oc summarize this" }))
    expect(r.handled).toBe(true)
    expect(r.query).toBe("summarize this")
  })

  test("bare trigger returns empty query", () => {
    const r = resolveTelegramQuery(baseInput({ text: "!oc" }))
    expect(r.handled).toBe(true)
    expect(r.query).toBe("")
  })

  test("trigger-prefix is matched even when other flags are off", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "!oc hi",
        respondToMentions: false,
        respondToReplies: false,
        respondToImplicitTopicReplies: false,
        threadIsolation: false,
      })
    )
    expect(r.handled).toBe(true)
    expect(r.query).toBe("hi")
  })

  test("trigger matching is case-insensitive (trigger prefix branch is exact)", () => {
    // The original code only matches the trigger prefix literally. We document
    // that -- mixed-case trigger text is NOT recognized as a trigger.
    const r = resolveTelegramQuery(baseInput({ text: "!OC hi" }))
    // Falls through to whatever else applies; in a group with no other branch
    // this is dropped.
    expect(r.handled).toBe(false)
  })
})

// =============================================================================
// @mention
// =============================================================================

describe("resolveTelegramQuery - @mention", () => {
  test("strips @mention and forwards the rest", () => {
    const r = resolveTelegramQuery(baseInput({ text: "@ocbot hello" }))
    expect(r.handled).toBe(true)
    expect(r.query).toBe("hello")
  })

  test("bare @mention returns empty query", () => {
    const r = resolveTelegramQuery(baseInput({ text: "@ocbot" }))
    expect(r.handled).toBe(true)
    expect(r.query).toBe("")
  })

  test("respects respondToMentions=false (drops even a bare @mention)", () => {
    const r = resolveTelegramQuery(
      baseInput({ text: "@ocbot hello", respondToMentions: false })
    )
    expect(r.handled).toBe(false)
  })
})

// =============================================================================
// DM
// =============================================================================

describe("resolveTelegramQuery - DM", () => {
  test("forwards any non-empty text in a private chat", () => {
    const r = resolveTelegramQuery(baseInput({ text: "hi there", isPrivate: true }))
    expect(r.handled).toBe(true)
    expect(r.query).toBe("hi there")
  })
})

// =============================================================================
// Implicit topic reply (the new flag's branch)
// =============================================================================

describe("resolveTelegramQuery - implicit topic reply", () => {
  const topicInput: Partial<ResolveTelegramQueryInput> = {
    isPrivate: false,
    messageThreadId: 7,
    threadIsolation: true,
    hasActiveSession: true,
  }

  test("forwards plain text inside an active topic by default", () => {
    const r = resolveTelegramQuery(baseInput({ text: "continue that", ...topicInput }))
    expect(r.handled).toBe(true)
    expect(r.query).toBe("continue that")
  })

  test("drops plain text when respondToImplicitTopicReplies is false", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "continue that",
        ...topicInput,
        respondToImplicitTopicReplies: false,
      })
    )
    expect(r.handled).toBe(false)
  })

  test("still drops plain text when threadIsolation is off (independent of flag)", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "continue that",
        messageThreadId: 7,
        hasActiveSession: true,
        threadIsolation: false,
      })
    )
    expect(r.handled).toBe(false)
  })

  test("still drops plain text when no active session for the topic", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "continue that",
        messageThreadId: 7,
        hasActiveSession: false,
      })
    )
    expect(r.handled).toBe(false)
  })

  test("trigger-prefixed messages still match even when respondToImplicitTopicReplies is false", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "!oc please continue",
        ...topicInput,
        respondToImplicitTopicReplies: false,
      })
    )
    expect(r.handled).toBe(true)
    expect(r.query).toBe("please continue")
  })

  test("@mention still matches even when respondToImplicitTopicReplies is false", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "@ocbot please continue",
        ...topicInput,
        respondToImplicitTopicReplies: false,
      })
    )
    expect(r.handled).toBe(true)
    expect(r.query).toBe("please continue")
  })

  test("swipe-reply still matches even when respondToImplicitTopicReplies is false", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "thanks!",
        ...topicInput,
        respondToImplicitTopicReplies: false,
        replyToMessageIsBot: true,
        replyToMessageFromId: String(OUR_BOT_ID),
      })
    )
    expect(r.handled).toBe(true)
    expect(r.query).toBe("thanks!")
  })

  test("attachment-only reply still bypasses trigger when respondToImplicitTopicReplies is false", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "",
        ...topicInput,
        respondToImplicitTopicReplies: false,
        hasAttachments: true,
      })
    )
    expect(r.handled).toBe(true)
    expect(r.query).toBe("")
  })
})

// =============================================================================
// Swipe-reply to the bot
// =============================================================================

describe("resolveTelegramQuery - swipe-reply to bot", () => {
  test("forwards swipe-reply to the bot inside an active chat", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "thanks!",
        hasActiveSession: true,
        replyToMessageIsBot: true,
        replyToMessageFromId: String(OUR_BOT_ID),
      })
    )
    expect(r.handled).toBe(true)
    expect(r.query).toBe("thanks!")
  })

  test("drops swipe-reply when respondToReplies is false", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "thanks!",
        hasActiveSession: true,
        replyToMessageIsBot: true,
        replyToMessageFromId: String(OUR_BOT_ID),
        respondToReplies: false,
      })
    )
    expect(r.handled).toBe(false)
  })

  test("drops swipe-reply to a different bot", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "thanks!",
        hasActiveSession: true,
        replyToMessageIsBot: true,
        replyToMessageFromId: "99999",
      })
    )
    expect(r.handled).toBe(false)
  })

  test("drops swipe-reply when no active session for the chat", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "thanks!",
        hasActiveSession: false,
        replyToMessageIsBot: true,
        replyToMessageFromId: String(OUR_BOT_ID),
      })
    )
    expect(r.handled).toBe(false)
  })
})

// =============================================================================
// Attachment bypass
// =============================================================================

describe("resolveTelegramQuery - attachment bypass", () => {
  test("caption-less attachment in a DM is forwarded", () => {
    const r = resolveTelegramQuery(
      baseInput({ text: "", isPrivate: true, hasAttachments: true })
    )
    expect(r.handled).toBe(true)
    expect(r.query).toBe("")
  })

  test("caption-less attachment inside an active topic is forwarded", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "",
        messageThreadId: 7,
        hasActiveSession: true,
        hasAttachments: true,
      })
    )
    expect(r.handled).toBe(true)
    expect(r.query).toBe("")
  })

  test("caption-less attachment in a plain group is dropped", () => {
    const r = resolveTelegramQuery(
      baseInput({ text: "", hasAttachments: true })
    )
    expect(r.handled).toBe(false)
  })
})

// =============================================================================
// Combined flag behavior
// =============================================================================

describe("resolveTelegramQuery - combined flag behavior", () => {
  test("plain text in a topic is dropped when both mentions and replies are off and implicit replies are off", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "continue that",
        messageThreadId: 7,
        hasActiveSession: true,
        respondToMentions: false,
        respondToReplies: false,
        respondToImplicitTopicReplies: false,
      })
    )
    expect(r.handled).toBe(false)
  })

  test("trigger still works even with respondToImplicitTopicReplies=false", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "!oc continue",
        messageThreadId: 7,
        hasActiveSession: true,
        respondToImplicitTopicReplies: false,
      })
    )
    expect(r.handled).toBe(true)
    expect(r.query).toBe("continue")
  })

  test("isReplyToThisBot flag is set on swipe-reply results", () => {
    const r = resolveTelegramQuery(
      baseInput({
        text: "thanks!",
        hasActiveSession: true,
        replyToMessageIsBot: true,
        replyToMessageFromId: String(OUR_BOT_ID),
      })
    )
    expect(r.isReplyToThisBot).toBe(true)
  })

  test("isReplyToThisBot flag is false on trigger results", () => {
    const r = resolveTelegramQuery(baseInput({ text: "!oc hi" }))
    expect(r.isReplyToThisBot).toBe(false)
  })
})
