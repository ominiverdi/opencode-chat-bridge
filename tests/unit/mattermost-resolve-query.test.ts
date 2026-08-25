/**
 * Unit tests for resolveMattermostQuery
 * Covers the trigger/@mention/DM/implicit-thread-reply dispatch, including
 * the respondToThreadReplies flag.
 */

import { describe, test, expect } from "bun:test"
import { resolveMattermostQuery } from "../../connectors/mattermost"

const BASE = {
  trigger: "!oc",
  botUsername: "bot_rnd",
  isDM: false,
  threadIsolation: true,
  respondToMentions: true,
  respondToThreadReplies: true,
  hasActiveSession: false,
  rootId: "",
}

// =============================================================================
// Trigger prefix
// =============================================================================

describe("resolveMattermostQuery - trigger", () => {
  test("returns query after trigger with space", () => {
    const r = resolveMattermostQuery({ ...BASE, message: "!oc what time is it?" })
    expect(r).toEqual({ query: "what time is it?", isImplicitThreadReply: false })
  })

  test("returns query after trigger without space", () => {
    const r = resolveMattermostQuery({ ...BASE, message: "!ochello" })
    expect(r).toEqual({ query: "hello", isImplicitThreadReply: false })
  })

  test("returns empty query when trigger is the whole message", () => {
    const r = resolveMattermostQuery({ ...BASE, message: "!oc" })
    expect(r).toEqual({ query: "", isImplicitThreadReply: false })
  })
})

// =============================================================================
// @mention
// =============================================================================

describe("resolveMattermostQuery - @mention", () => {
  test("returns query after mention with space", () => {
    const r = resolveMattermostQuery({ ...BASE, message: "@bot_rnd hello" })
    expect(r).toEqual({ query: "hello", isImplicitThreadReply: false })
  })

  test("returns query after mention without space", () => {
    const r = resolveMattermostQuery({ ...BASE, message: "@bot_rndhello" })
    expect(r).toEqual({ query: "hello", isImplicitThreadReply: false })
  })

  test("mention ignored when respondToMentions is false", () => {
    const r = resolveMattermostQuery({
      ...BASE,
      respondToMentions: false,
      message: "@bot_rnd hello",
    })
    expect(r).toBeNull()
  })
})

// =============================================================================
// Direct messages
// =============================================================================

describe("resolveMattermostQuery - DM", () => {
  test("plain DM message is always forwarded", () => {
    const r = resolveMattermostQuery({ ...BASE, isDM: true, message: "just chatting" })
    expect(r).toEqual({ query: "just chatting", isImplicitThreadReply: false })
  })

  test("plain DM message forwarded even without an active session", () => {
    const r = resolveMattermostQuery({
      ...BASE,
      isDM: true,
      hasActiveSession: false,
      message: "first message in DM",
    })
    expect(r).toEqual({ query: "first message in DM", isImplicitThreadReply: false })
  })
})

// =============================================================================
// Implicit thread replies
// =============================================================================

describe("resolveMattermostQuery - implicit thread replies", () => {
  test("plain thread reply is forwarded when an active session exists", () => {
    const r = resolveMattermostQuery({
      ...BASE,
      message: "continue please",
      rootId: "root1",
      hasActiveSession: true,
    })
    expect(r).toEqual({ query: "continue please", isImplicitThreadReply: true })
  })

  test("plain thread reply is dropped when respondToThreadReplies is false", () => {
    const r = resolveMattermostQuery({
      ...BASE,
      respondToThreadReplies: false,
      message: "continue please",
      rootId: "root1",
      hasActiveSession: true,
    })
    expect(r).toBeNull()
  })

  test("plain thread reply is dropped without an active session", () => {
    const r = resolveMattermostQuery({
      ...BASE,
      message: "continue please",
      rootId: "root1",
      hasActiveSession: false,
    })
    expect(r).toBeNull()
  })

  test("plain thread reply is dropped when threadIsolation is false", () => {
    const r = resolveMattermostQuery({
      ...BASE,
      threadIsolation: false,
      message: "continue please",
      rootId: "root1",
      hasActiveSession: true,
    })
    expect(r).toBeNull()
  })

  test("top-level plain message is dropped", () => {
    const r = resolveMattermostQuery({
      ...BASE,
      message: "just chatting",
      rootId: "",
      hasActiveSession: true,
    })
    expect(r).toBeNull()
  })

  test("trigger still wins when respondToThreadReplies is false", () => {
    const r = resolveMattermostQuery({
      ...BASE,
      respondToThreadReplies: false,
      message: "!oc continue please",
      rootId: "root1",
      hasActiveSession: true,
    })
    expect(r).toEqual({ query: "continue please", isImplicitThreadReply: false })
  })

  test("mention still wins when respondToThreadReplies is false", () => {
    const r = resolveMattermostQuery({
      ...BASE,
      respondToThreadReplies: false,
      message: "@bot_rnd continue please",
      rootId: "root1",
      hasActiveSession: true,
    })
    expect(r).toEqual({ query: "continue please", isImplicitThreadReply: false })
  })
})
