/**
 * Unit tests for Slack thread context helpers
 * Tests the pure functions exported from connectors/slack.ts
 */

import { describe, test, expect } from "bun:test"
import {
  buildSessionContextId,
  resolveThreadTs,
  normalizeSlackEventContext,
  buildThreadReplyPayload,
  shouldHandleThreadMessage,
} from "../../connectors/slack"

// =============================================================================
// buildSessionContextId
// =============================================================================

describe("buildSessionContextId", () => {
  test("builds key from channel and thread root ts", () => {
    const contextId = buildSessionContextId("C001", "1710000000.111")
    expect(contextId).toBe("C001:1710000000.111")
  })
})

// =============================================================================
// resolveThreadTs
// =============================================================================

describe("resolveThreadTs", () => {
  test("uses event ts as root when message is top-level", () => {
    const rootTs = resolveThreadTs(undefined, "1710000000.222")
    expect(rootTs).toBe("1710000000.222")
  })

  test("uses thread_ts as root when message is in a thread", () => {
    const rootTs = resolveThreadTs("1710000000.333", "1710000000.444")
    expect(rootTs).toBe("1710000000.333")
  })
})

// =============================================================================
// normalizeSlackEventContext
// =============================================================================

describe("normalizeSlackEventContext", () => {
  test("normalizes event context and computes dedupe id", () => {
    const ctx = normalizeSlackEventContext({
      teamId: "T010",
      channelId: "C010",
      userId: "U010",
      text: "<@U_BOT> hello",
      eventTs: "1710000010.100",
      threadTs: "1710000010.000",
    })

    expect(ctx.contextId).toBe("C010:1710000010.000")
    expect(ctx.replyThreadTs).toBe("1710000010.000")
    expect(ctx.dedupeId).toBe("C010:1710000010.100")
  })

  test("contextId is identical with or without teamId", () => {
    const withTeam = normalizeSlackEventContext({
      teamId: "T010",
      channelId: "C010",
      eventTs: "1710000010.100",
      threadTs: "1710000010.000",
    })
    const withoutTeam = normalizeSlackEventContext({
      channelId: "C010",
      eventTs: "1710000010.100",
      threadTs: "1710000010.000",
    })

    expect(withTeam.contextId).toBe(withoutTeam.contextId)
    expect(withTeam.contextId).toBe("C010:1710000010.000")
  })

  test("top-level message uses eventTs as thread root", () => {
    const ctx = normalizeSlackEventContext({
      channelId: "C010",
      eventTs: "1710000010.100",
    })

    expect(ctx.contextId).toBe("C010:1710000010.100")
    expect(ctx.replyThreadTs).toBe("1710000010.100")
  })

  test("throws when channel is missing", () => {
    expect(() =>
      normalizeSlackEventContext({ channelId: "", eventTs: "1710000010.100" })
    ).toThrow("Missing required Slack fields")
  })

  test("throws when eventTs is missing", () => {
    expect(() =>
      normalizeSlackEventContext({ channelId: "C010", eventTs: "" })
    ).toThrow("Missing required Slack fields")
  })

  test("uses channel-based fallback when teamId is absent", () => {
    const ctx = normalizeSlackEventContext({
      channelId: "C010",
      userId: "U010",
      text: "follow up",
      eventTs: "1710000010.200",
      threadTs: "1710000010.000",
    })

    expect(ctx.teamId).toBe("ch_C010")
  })
})

// =============================================================================
// buildThreadReplyPayload
// =============================================================================

describe("buildThreadReplyPayload", () => {
  test("builds valid payload", () => {
    const payload = buildThreadReplyPayload("C999", "1710000099.000", "hello")
    expect(payload).toEqual({
      channel: "C999",
      text: "hello",
      thread_ts: "1710000099.000",
    })
  })

  test("throws when thread_ts is empty", () => {
    expect(() => buildThreadReplyPayload("C999", "", "hello")).toThrow("thread_ts")
  })
})

// =============================================================================
// shouldHandleThreadMessage
// =============================================================================

describe("shouldHandleThreadMessage", () => {
  test("accepts plain thread replies", () => {
    expect(shouldHandleThreadMessage({
      text: "continue this",
      threadTs: "1710000000.123",
      trigger: "!oc",
    })).toBe(true)
  })

  test("rejects non-thread messages", () => {
    expect(shouldHandleThreadMessage({
      text: "continue this",
      trigger: "!oc",
    })).toBe(false)
  })

  test("rejects trigger-prefixed messages", () => {
    expect(shouldHandleThreadMessage({
      text: "!oc query",
      threadTs: "1710000000.123",
      trigger: "!oc",
    })).toBe(false)
  })

  test("rejects @mention messages", () => {
    expect(shouldHandleThreadMessage({
      text: "<@U123> hi",
      threadTs: "1710000000.123",
      trigger: "!oc",
    })).toBe(false)
  })

  test("rejects bot_message subtype", () => {
    expect(shouldHandleThreadMessage({
      text: "hello",
      threadTs: "1710000000.123",
      trigger: "!oc",
      subtype: "bot_message",
    })).toBe(false)
  })

  test("rejects message_changed subtype", () => {
    expect(shouldHandleThreadMessage({
      text: "hello",
      threadTs: "1710000000.123",
      trigger: "!oc",
      subtype: "message_changed",
    })).toBe(false)
  })

  test("rejects message_deleted subtype", () => {
    expect(shouldHandleThreadMessage({
      text: "hello",
      threadTs: "1710000000.123",
      trigger: "!oc",
      subtype: "message_deleted",
    })).toBe(false)
  })

  test("rejects messages with botId", () => {
    expect(shouldHandleThreadMessage({
      text: "hello",
      threadTs: "1710000000.123",
      trigger: "!oc",
      botId: "B123",
    })).toBe(false)
  })

  test("rejects empty text", () => {
    expect(shouldHandleThreadMessage({
      text: "",
      threadTs: "1710000000.123",
      trigger: "!oc",
    })).toBe(false)
  })

  test("accepts thread_broadcast subtype", () => {
    expect(shouldHandleThreadMessage({
      text: "hello",
      threadTs: "1710000000.123",
      trigger: "!oc",
      subtype: "thread_broadcast",
    })).toBe(true)
  })

  test("trigger matching is case-insensitive", () => {
    expect(shouldHandleThreadMessage({
      text: "!OC query",
      threadTs: "1710000000.123",
      trigger: "!oc",
    })).toBe(false)
  })
})
