/**
 * Unit tests for Matrix thread context helpers
 */

import { describe, test, expect } from "bun:test"
import {
  extractThreadRootId,
  resolveThreadRoot,
  buildMatrixSessionId,
  normalizeMatrixEventContext,
  buildThreadRelation,
  shouldHandleThreadReply,
} from "../../connectors/matrix-thread-helpers"

// =============================================================================
// extractThreadRootId
// =============================================================================

describe("extractThreadRootId", () => {
  test("extracts thread root from m.thread relation", () => {
    const event = {
      content: {
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$root123",
        },
      },
    }
    expect(extractThreadRootId(event)).toBe("$root123")
  })

  test("returns empty for non-threaded events", () => {
    const event = { content: { body: "hello" } }
    expect(extractThreadRootId(event)).toBe("")
  })

  test("returns empty for m.annotation relations", () => {
    const event = {
      content: {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: "$some_event",
          key: "thumbsup",
        },
      },
    }
    expect(extractThreadRootId(event)).toBe("")
  })

  test("returns empty for missing content", () => {
    expect(extractThreadRootId({})).toBe("")
    expect(extractThreadRootId(null)).toBe("")
    expect(extractThreadRootId(undefined)).toBe("")
  })
})

// =============================================================================
// resolveThreadRoot
// =============================================================================

describe("resolveThreadRoot", () => {
  test("uses eventId when no thread root", () => {
    expect(resolveThreadRoot("", "$event456")).toBe("$event456")
  })

  test("uses thread root when present", () => {
    expect(resolveThreadRoot("$root123", "$event456")).toBe("$root123")
  })
})

// =============================================================================
// buildMatrixSessionId
// =============================================================================

describe("buildMatrixSessionId", () => {
  test("returns room:threadRoot when isolation is on", () => {
    expect(buildMatrixSessionId("!room:server", "$root1", true)).toBe("!room:server:$root1")
  })

  test("returns plain room when isolation is off", () => {
    expect(buildMatrixSessionId("!room:server", "$root1", false)).toBe("!room:server")
  })

  test("two threads in same room get different IDs when on", () => {
    const id1 = buildMatrixSessionId("!room:server", "$root1", true)
    const id2 = buildMatrixSessionId("!room:server", "$root2", true)
    expect(id1).not.toBe(id2)
  })

  test("two threads in same room get same ID when off", () => {
    const id1 = buildMatrixSessionId("!room:server", "$root1", false)
    const id2 = buildMatrixSessionId("!room:server", "$root2", false)
    expect(id1).toBe(id2)
  })
})

// =============================================================================
// normalizeMatrixEventContext
// =============================================================================

describe("normalizeMatrixEventContext", () => {
  test("normalizes threaded event with isolation on", () => {
    const ctx = normalizeMatrixEventContext({
      roomId: "!room:server",
      sender: "@user:server",
      text: "follow up",
      eventId: "$event222",
      threadRootEventId: "$root111",
    }, true)

    expect(ctx.sessionId).toBe("!room:server:$root111")
    expect(ctx.replyThreadRootId).toBe("$root111")
    expect(ctx.dedupeId).toBe("$event222")
  })

  test("top-level message uses eventId as thread root", () => {
    const ctx = normalizeMatrixEventContext({
      roomId: "!room:server",
      eventId: "$event333",
    }, true)

    expect(ctx.sessionId).toBe("!room:server:$event333")
    expect(ctx.replyThreadRootId).toBe("$event333")
  })

  test("uses room as session ID when isolation is off", () => {
    const ctx = normalizeMatrixEventContext({
      roomId: "!room:server",
      eventId: "$event444",
      threadRootEventId: "$root111",
    }, false)

    expect(ctx.sessionId).toBe("!room:server")
  })

  test("handles missing optional fields", () => {
    const ctx = normalizeMatrixEventContext({
      roomId: "!room:server",
      eventId: "$event555",
    }, true)

    expect(ctx.sender).toBe("unknown")
    expect(ctx.text).toBe("")
    expect(ctx.threadRootEventId).toBe("")
  })
})

// =============================================================================
// buildThreadRelation
// =============================================================================

describe("buildThreadRelation", () => {
  test("builds correct m.thread relation", () => {
    const relation = buildThreadRelation("$root123", "$last456")
    expect(relation).toEqual({
      rel_type: "m.thread",
      event_id: "$root123",
      is_falling_back: true,
      "m.in_reply_to": {
        event_id: "$last456",
      },
    })
  })
})

// =============================================================================
// shouldHandleThreadReply
// =============================================================================

describe("shouldHandleThreadReply", () => {
  test("accepts plain thread replies", () => {
    expect(shouldHandleThreadReply({
      text: "continue this",
      threadRootEventId: "$root123",
      trigger: "!oc",
      botUserId: "@bot:server",
    })).toBe(true)
  })

  test("rejects non-thread messages", () => {
    expect(shouldHandleThreadReply({
      text: "hello",
      threadRootEventId: "",
      trigger: "!oc",
      botUserId: "@bot:server",
    })).toBe(false)
  })

  test("rejects trigger-prefixed messages", () => {
    expect(shouldHandleThreadReply({
      text: "!oc query",
      threadRootEventId: "$root123",
      trigger: "!oc",
      botUserId: "@bot:server",
    })).toBe(false)
  })

  test("rejects messages mentioning bot", () => {
    expect(shouldHandleThreadReply({
      text: "hey @bot:server what do you think",
      threadRootEventId: "$root123",
      trigger: "!oc",
      botUserId: "@bot:server",
    })).toBe(false)
  })

  test("rejects empty text", () => {
    expect(shouldHandleThreadReply({
      text: "",
      threadRootEventId: "$root123",
      trigger: "!oc",
      botUserId: "@bot:server",
    })).toBe(false)
  })
})
