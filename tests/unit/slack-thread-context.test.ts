import { describe, test, expect } from "bun:test"
import {
  buildSessionContextId,
  resolveThreadTs,
  normalizeSlackEventContext,
  buildThreadReplyPayload,
  shouldHandleThreadMessage,
} from "../../connectors/slack"

describe("slack thread context keying", () => {
  test("builds session context id from channel and thread root ts (no team)", () => {
    const contextId = buildSessionContextId("C001", "1710000000.111")
    expect(contextId).toBe("C001:1710000000.111")
  })

  test("uses event ts as root when message is top-level", () => {
    const rootTs = resolveThreadTs(undefined, "1710000000.222")
    const contextId = buildSessionContextId("C002", rootTs)

    expect(rootTs).toBe("1710000000.222")
    expect(contextId).toBe("C002:1710000000.222")
  })

  test("uses thread_ts as root when message is in a thread", () => {
    const rootTs = resolveThreadTs("1710000000.333", "1710000000.444")
    const contextId = buildSessionContextId("C003", rootTs)

    expect(rootTs).toBe("1710000000.333")
    expect(contextId).toBe("C003:1710000000.333")
  })

  test("normalizes event context and computes dedupe id", () => {
    const normalized = normalizeSlackEventContext({
      teamId: "T010",
      channelId: "C010",
      userId: "U010",
      text: "<@U_BOT> hello",
      eventTs: "1710000010.100",
      threadTs: "1710000010.000",
    })

    // contextId uses channel:threadTs (no teamId) for consistent session lookup
    expect(normalized.contextId).toBe("C010:1710000010.000")
    expect(normalized.replyThreadTs).toBe("1710000010.000")
    expect(normalized.dedupeId).toBe("C010:1710000010.100")
  })

  test("contextId is identical with or without teamId (session key consistency)", () => {
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

    // Both must resolve to the same session key regardless of teamId presence
    expect(withTeam.contextId).toBe(withoutTeam.contextId)
    expect(withTeam.contextId).toBe("C010:1710000010.000")
  })

  test("throws when required Slack fields are missing (channel or ts)", () => {
    expect(() =>
      normalizeSlackEventContext({
        channelId: "",
        eventTs: "1710000010.100",
      })
    ).toThrow("Missing required Slack fields")

    expect(() =>
      normalizeSlackEventContext({
        channelId: "C010",
        eventTs: "",
      })
    ).toThrow("Missing required Slack fields")
  })

  test("succeeds when teamId is absent (uses channel-based fallback)", () => {
    const normalized = normalizeSlackEventContext({
      channelId: "C010",
      userId: "U010",
      text: "follow up",
      eventTs: "1710000010.200",
      threadTs: "1710000010.000",
    })

    expect(normalized.contextId).toBe("C010:1710000010.000")
    expect(normalized.teamId).toBe("ch_C010")
  })

  test("builds thread-only reply payload", () => {
    const payload = buildThreadReplyPayload("C999", "1710000099.000", "hello")
    expect(payload).toEqual({
      channel: "C999",
      text: "hello",
      thread_ts: "1710000099.000",
    })
  })

  test("rejects reply payload without thread_ts", () => {
    expect(() => buildThreadReplyPayload("C999", "", "hello")).toThrow("thread_ts")
  })

  test("thread messages without trigger/mention are handled", () => {
    expect(shouldHandleThreadMessage({
      text: "continue this",
      threadTs: "1710000000.123",
      trigger: "!sql",
    })).toBe(true)
  })

  test("non-thread messages are ignored by implicit thread handler", () => {
    expect(shouldHandleThreadMessage({
      text: "continue this",
      trigger: "!sql",
    })).toBe(false)
  })

  test("trigger and mention messages are excluded from implicit thread handler", () => {
    expect(shouldHandleThreadMessage({
      text: "!sql query",
      threadTs: "1710000000.123",
      trigger: "!sql",
    })).toBe(false)

    expect(shouldHandleThreadMessage({
      text: "<@U123> hi",
      threadTs: "1710000000.123",
      trigger: "!sql",
    })).toBe(false)
  })

  test("bot/edit/delete subtypes are excluded from implicit thread handler", () => {
    expect(shouldHandleThreadMessage({
      text: "hello",
      threadTs: "1710000000.123",
      trigger: "!sql",
      subtype: "bot_message",
    })).toBe(false)

    expect(shouldHandleThreadMessage({
      text: "hello",
      threadTs: "1710000000.123",
      trigger: "!sql",
      subtype: "message_changed",
    })).toBe(false)

    expect(shouldHandleThreadMessage({
      text: "hello",
      threadTs: "1710000000.123",
      trigger: "!sql",
      subtype: "message_deleted",
    })).toBe(false)
  })

  test("thread_broadcast and unknown subtype are accepted for user activity", () => {
    expect(shouldHandleThreadMessage({
      text: "hello",
      threadTs: "1710000000.123",
      trigger: "!sql",
      subtype: "thread_broadcast",
    })).toBe(true)

    expect(shouldHandleThreadMessage({
      text: "hello",
      threadTs: "1710000000.123",
      trigger: "!sql",
      subtype: "some_other_subtype",
    })).toBe(true)
  })

  test("trigger matching is case-insensitive for implicit thread filtering", () => {
    expect(shouldHandleThreadMessage({
      text: "!SQL query",
      threadTs: "1710000000.123",
      trigger: "!sql",
    })).toBe(false)
  })

})
