/**
 * Integration tests for Mattermost event-to-context mapping
 * Tests the full flow from raw post fields to session ID and reply routing
 */

import { describe, test, expect } from "bun:test"
import {
  normalizeMattermostEventContext,
  buildMattermostSessionId,
} from "../../connectors/mattermost"

describe("mattermost event mapping integration", () => {
  test("top-level @mention maps to new thread rooted at post.id", () => {
    const ctx = normalizeMattermostEventContext({
      channelId: "ch1",
      userId: "u1",
      text: "@bot hello",
      postId: "post001",
      rootId: "",
    }, true)

    expect(ctx.sessionId).toBe("ch1:post001")
    expect(ctx.replyRootId).toBe("post001")
  })

  test("thread reply maps to existing root_id", () => {
    const ctx = normalizeMattermostEventContext({
      channelId: "ch1",
      userId: "u1",
      text: "follow up",
      postId: "post002",
      rootId: "post001",
    }, true)

    expect(ctx.sessionId).toBe("ch1:post001")
    expect(ctx.replyRootId).toBe("post001")
  })

  test("two threads in same channel get different sessions", () => {
    const thread1 = normalizeMattermostEventContext({
      channelId: "ch1",
      postId: "post001",
      rootId: "",
    }, true)
    const thread2 = normalizeMattermostEventContext({
      channelId: "ch1",
      postId: "post002",
      rootId: "",
    }, true)

    expect(thread1.sessionId).not.toBe(thread2.sessionId)
  })

  test("threadIsolation off gives same session for all threads in channel", () => {
    const thread1 = normalizeMattermostEventContext({
      channelId: "ch1",
      postId: "post001",
      rootId: "",
    }, false)
    const thread2 = normalizeMattermostEventContext({
      channelId: "ch1",
      postId: "post002",
      rootId: "post001",
    }, false)

    expect(thread1.sessionId).toBe(thread2.sessionId)
    expect(thread1.sessionId).toBe("ch1")
  })
})
