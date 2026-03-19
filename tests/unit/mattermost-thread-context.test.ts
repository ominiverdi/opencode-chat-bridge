/**
 * Unit tests for Mattermost thread context helpers
 * Tests the pure functions exported from connectors/mattermost.ts
 */

import { describe, test, expect } from "bun:test"
import {
  resolveRootId,
  buildMattermostSessionId,
  normalizeMattermostEventContext,
  shouldHandleThreadReply,
} from "../../connectors/mattermost"

// =============================================================================
// resolveRootId
// =============================================================================

describe("resolveRootId", () => {
  test("uses postId as root when message is top-level", () => {
    expect(resolveRootId(undefined, "post123")).toBe("post123")
  })

  test("uses root_id when message is a thread reply", () => {
    expect(resolveRootId("root456", "post789")).toBe("root456")
  })

  test("uses postId when root_id is empty string", () => {
    expect(resolveRootId("", "post123")).toBe("post123")
  })
})

// =============================================================================
// buildMattermostSessionId
// =============================================================================

describe("buildMattermostSessionId", () => {
  test("returns channel:rootId when threadIsolation is true", () => {
    expect(buildMattermostSessionId("ch1", "root1", true)).toBe("ch1:root1")
  })

  test("returns plain channel when threadIsolation is false", () => {
    expect(buildMattermostSessionId("ch1", "root1", false)).toBe("ch1")
  })

  test("two threads in same channel get same ID when isolation is off", () => {
    const id1 = buildMattermostSessionId("ch1", "root1", false)
    const id2 = buildMattermostSessionId("ch1", "root2", false)
    expect(id1).toBe(id2)
  })

  test("two threads in same channel get different IDs when isolation is on", () => {
    const id1 = buildMattermostSessionId("ch1", "root1", true)
    const id2 = buildMattermostSessionId("ch1", "root2", true)
    expect(id1).not.toBe(id2)
  })
})

// =============================================================================
// normalizeMattermostEventContext
// =============================================================================

describe("normalizeMattermostEventContext", () => {
  test("normalizes thread reply with threadIsolation on", () => {
    const ctx = normalizeMattermostEventContext({
      channelId: "ch1",
      userId: "u1",
      text: "follow up",
      postId: "post222",
      rootId: "post111",
    }, true)

    expect(ctx.sessionId).toBe("ch1:post111")
    expect(ctx.replyRootId).toBe("post111")
    expect(ctx.dedupeId).toBe("ch1:post222")
    expect(ctx.rootId).toBe("post111")
  })

  test("top-level message uses postId as root", () => {
    const ctx = normalizeMattermostEventContext({
      channelId: "ch1",
      userId: "u1",
      text: "hello",
      postId: "post333",
      rootId: "",
    }, true)

    expect(ctx.sessionId).toBe("ch1:post333")
    expect(ctx.replyRootId).toBe("post333")
  })

  test("uses channel as session ID when threadIsolation is off", () => {
    const ctx = normalizeMattermostEventContext({
      channelId: "ch1",
      postId: "post444",
      rootId: "post111",
    }, false)

    expect(ctx.sessionId).toBe("ch1")
  })

  test("handles missing optional fields", () => {
    const ctx = normalizeMattermostEventContext({
      channelId: "ch1",
      postId: "post555",
    }, true)

    expect(ctx.userId).toBe("unknown")
    expect(ctx.text).toBe("")
    expect(ctx.rootId).toBe("")
    expect(ctx.replyRootId).toBe("post555")
  })
})

// =============================================================================
// shouldHandleThreadReply
// =============================================================================

describe("shouldHandleThreadReply", () => {
  test("accepts plain thread replies", () => {
    expect(shouldHandleThreadReply({
      text: "continue this",
      rootId: "root123",
      trigger: "!oc",
      botUsername: "ocbot",
    })).toBe(true)
  })

  test("rejects non-thread messages (no rootId)", () => {
    expect(shouldHandleThreadReply({
      text: "hello",
      rootId: "",
      trigger: "!oc",
      botUsername: "ocbot",
    })).toBe(false)
  })

  test("rejects trigger-prefixed messages", () => {
    expect(shouldHandleThreadReply({
      text: "!oc do something",
      rootId: "root123",
      trigger: "!oc",
      botUsername: "ocbot",
    })).toBe(false)
  })

  test("rejects @mention messages", () => {
    expect(shouldHandleThreadReply({
      text: "@ocbot hi",
      rootId: "root123",
      trigger: "!oc",
      botUsername: "ocbot",
    })).toBe(false)
  })

  test("rejects empty text", () => {
    expect(shouldHandleThreadReply({
      text: "",
      rootId: "root123",
      trigger: "!oc",
      botUsername: "ocbot",
    })).toBe(false)
  })

  test("trigger matching is case-insensitive", () => {
    expect(shouldHandleThreadReply({
      text: "!OC do something",
      rootId: "root123",
      trigger: "!oc",
      botUsername: "ocbot",
    })).toBe(false)
  })
})
