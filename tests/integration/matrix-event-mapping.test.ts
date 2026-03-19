/**
 * Integration tests for Matrix event-to-context mapping
 */

import { describe, test, expect } from "bun:test"
import {
  extractThreadRootId,
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
})
