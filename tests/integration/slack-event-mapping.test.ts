import { describe, test, expect } from "bun:test"
import { normalizeSlackEventContext, buildThreadReplyPayload, postThreadReply } from "../../connectors/slack"

describe("slack event mapping integration", () => {
  test("top-level mention maps to new thread rooted at event.ts", () => {
    const context = normalizeSlackEventContext({
      teamId: "TAPP",
      channelId: "CCHAN",
      userId: "UUSER",
      text: "<@UBOT> summarize this",
      eventTs: "1711111111.001",
    })

    const payload = buildThreadReplyPayload(context.channelId, context.replyThreadTs, "ack")
    expect(payload.thread_ts).toBe("1711111111.001")
    expect(context.contextId).toBe("CCHAN:1711111111.001")
  })

  test("thread reply maps to existing parent thread_ts", () => {
    const context = normalizeSlackEventContext({
      teamId: "TAPP",
      channelId: "CCHAN",
      userId: "UUSER",
      text: "!oc continue",
      eventTs: "1711111111.222",
      threadTs: "1711111111.100",
    })

    const payload = buildThreadReplyPayload(context.channelId, context.replyThreadTs, "ack")
    expect(payload.thread_ts).toBe("1711111111.100")
    expect(context.contextId).toBe("CCHAN:1711111111.100")
  })

  test("postThreadReply always sends thread_ts", async () => {
    const calls: Array<{ channel: string; text: string; thread_ts: string }> = []
    const mockClient = {
      chat: {
        postMessage: async (payload: { channel: string; text: string; thread_ts: string }) => {
          calls.push(payload)
        },
      },
    }

    await postThreadReply(mockClient, "CCHAN", "1711111111.100", "reply")

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      channel: "CCHAN",
      text: "reply",
      thread_ts: "1711111111.100",
    })
  })
})
