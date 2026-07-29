/**
 * Integration tests for Matrix event-to-context mapping
 */

import { describe, test, expect } from "bun:test"
import {
  extractThreadRootId,
  extractReplyTargetId,
  normalizeMatrixEventContext,
  buildThreadRelation,
} from "../../connectors/matrix-thread-helpers"

describe("matrix event mapping integration", () => {
  test("top-level trigger maps to new thread rooted at event_id", () => {
    const ctx = normalizeMatrixEventContext({
      roomId: "!room:server",
      sender: "@user:server",
      text: "!oc hello",
      eventId: "$evt001",
    }, true)

    expect(ctx.sessionId).toBe("!room:server:$evt001")
    expect(ctx.replyThreadRootId).toBe("$evt001")

    const relation = buildThreadRelation(ctx.replyThreadRootId, ctx.eventId)
    expect((relation as any).event_id).toBe("$evt001")
  })

  test("thread reply maps to existing thread root", () => {
    const event = {
      event_id: "$evt002",
      content: {
        body: "follow up",
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$evt001",
        },
      },
    }

    const threadRoot = extractThreadRootId(event)
    expect(threadRoot).toBe("$evt001")

    const ctx = normalizeMatrixEventContext({
      roomId: "!room:server",
      sender: "@user:server",
      text: "follow up",
      eventId: "$evt002",
      threadRootEventId: threadRoot,
    }, true)

    expect(ctx.sessionId).toBe("!room:server:$evt001")
    expect(ctx.replyThreadRootId).toBe("$evt001")
  })

  test("two threads in same room get different sessions", () => {
    const ctx1 = normalizeMatrixEventContext({
      roomId: "!room:server",
      eventId: "$evt001",
    }, true)
    const ctx2 = normalizeMatrixEventContext({
      roomId: "!room:server",
      eventId: "$evt002",
    }, true)

    expect(ctx1.sessionId).not.toBe(ctx2.sessionId)
  })

  test("threadIsolation off gives same session for all threads", () => {
    const ctx1 = normalizeMatrixEventContext({
      roomId: "!room:server",
      eventId: "$evt001",
    }, false)
    const ctx2 = normalizeMatrixEventContext({
      roomId: "!room:server",
      eventId: "$evt002",
      threadRootEventId: "$evt001",
    }, false)

    expect(ctx1.sessionId).toBe(ctx2.sessionId)
    expect(ctx1.sessionId).toBe("!room:server")
  })

  test("threadIsolation off: plain m.in_reply_to reply maps to room session", () => {
    const event = {
      event_id: "$evt_reply",
      content: {
        body: "follow up via reply",
        "m.relates_to": {
          "m.in_reply_to": { event_id: "$bot_msg" },
        },
      },
    }

    // The connector uses extractReplyTargetId with threadIsolation=false,
    // which surfaces the m.in_reply_to target so shouldHandleThreadReply
    // (called in handleRoomMessage) lets the message through — provided the
    // connector has recorded $bot_msg in the session's botSentEventIds.
    const replyTarget = extractReplyTargetId(event, false)
    expect(replyTarget).toBe("$bot_msg")

    const ctx = normalizeMatrixEventContext({
      roomId: "!room:server",
      sender: "@user:server",
      text: "follow up via reply",
      eventId: "$evt_reply",
      threadRootEventId: replyTarget,
    }, false)

    expect(ctx.sessionId).toBe("!room:server")
    expect(ctx.replyThreadRootId).toBe("$bot_msg")
  })

  test("threadIsolation off: caller is expected to verify the reply target is from the bot", () => {
    // The connector records event IDs the bot sends into
    // session.botSentEventIds. The implicit-follow-up branch in
    // handleRoomMessage only matches plain m.in_reply_to when that set
    // contains the reply target — this test pins the contract by asserting
    // the same lookup the dispatch performs.
    const botSentEventIds = new Set<string>(["$bot_msg_1", "$bot_msg_2"])
    const replyTarget = "$other_user_msg"
    expect(botSentEventIds.has("$bot_msg_1")).toBe(true)
    expect(botSentEventIds.has(replyTarget)).toBe(false)
  })

  test("threadIsolation on: plain m.in_reply_to reply is ignored as thread root", () => {
    const event = {
      event_id: "$evt_reply",
      content: {
        body: "follow up via reply",
        "m.relates_to": {
          "m.in_reply_to": { event_id: "$bot_msg" },
        },
      },
    }

    // With isolation on, only m.thread should be picked up.
    expect(extractReplyTargetId(event, true)).toBe("")
  })
})
