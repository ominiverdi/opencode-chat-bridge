import { describe, test, expect } from "bun:test"
import {
  buildThreadContextId,
  resolveThreadTs,
  normalizeSlackEventContext,
  buildThreadReplyPayload,
  shouldHandleThreadMessage,
} from "../../connectors/slack"

describe("slack thread context keying", () => {
  test("builds thread context id from team, channel, and thread root ts", () => {
    const contextId = buildThreadContextId("T001", "C001", "1710000000.111")
    expect(contextId).toBe("T001:C001:1710000000.111")
  })

  test("uses event ts as root when message is top-level", () => {
    const rootTs = resolveThreadTs(undefined, "1710000000.222")
    const contextId = buildThreadContextId("T002", "C002", rootTs)

    expect(rootTs).toBe("1710000000.222")
    expect(contextId).toBe("T002:C002:1710000000.222")
  })

  test("uses thread_ts as root when message is in a thread", () => {
    const rootTs = resolveThreadTs("1710000000.333", "1710000000.444")
    const contextId = buildThreadContextId("T003", "C003", rootTs)

    expect(rootTs).toBe("1710000000.333")
    expect(contextId).toBe("T003:C003:1710000000.333")
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

    expect(normalized.contextId).toBe("T010:C010:1710000010.000")
    expect(normalized.replyThreadTs).toBe("1710000010.000")
    expect(normalized.dedupeId).toBe("C010:1710000010.100")
  })

  test("throws when required Slack fields are missing", () => {
    expect(() =>
      normalizeSlackEventContext({
        teamId: "",
        channelId: "C010",
        eventTs: "1710000010.100",
      })
    ).toThrow("Missing required Slack fields")
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

})
