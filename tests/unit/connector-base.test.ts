/**
 * Unit tests for connector-base.ts
 * Tests RateLimiter, SessionManager, and CommandHandler
 */

import { describe, test, expect, beforeEach } from "bun:test"
import {
  RateLimiter,
  SessionManager,
  CommandHandler,
  BaseConnector,
  parseCsvList,
  formatToolCallMessage,
  resolveToolMessageMode,
  ToolActivityPresenter,
  ToolActivityController,
  shouldShowToolOutput,
  buildUserErrorMessage,
  USER_ERROR_DETAIL_MAX_LENGTH,
  type BaseSession,
  type SessionStats,
} from "../../src/connector-base"

// =============================================================================
// Tool message presentation
// =============================================================================

describe("tool message presentation", () => {
  const activity = {
    type: "tool_start" as const,
    tool: "mcp__time__get_current_time",
    message: "timezone=Europe/Madrid [mcp__time__get_current_time]",
    description: "timezone=Europe/Madrid",
    details: { timezone: "Europe/Madrid" },
  }

  test("hides calls when disabled", () => {
    expect(formatToolCallMessage(activity, {
      showCalls: false,
      showArguments: false,
      showOutputFor: ["bash"],
    })).toBeNull()
  })

  test("shows only the tool name by default", () => {
    expect(formatToolCallMessage(activity, {
      showCalls: true,
      showArguments: false,
      showOutputFor: ["bash"],
    })).toBe("[mcp__time__get_current_time]")
  })

  test("shows compact arguments when enabled", () => {
    expect(formatToolCallMessage(activity, {
      showCalls: true,
      showArguments: true,
      showOutputFor: ["bash"],
    })).toBe("timezone=Europe/Madrid [mcp__time__get_current_time]")
  })

  test("resolves explicit and legacy presentation modes", () => {
    expect(resolveToolMessageMode({
      mode: "trace",
      showCalls: true,
      showArguments: false,
      showOutputFor: [],
    })).toBe("trace")
    expect(resolveToolMessageMode({
      mode: "trace",
      showCalls: false,
      showArguments: false,
      showOutputFor: [],
    })).toBe("off")
  })

  test("maintains one cumulative editable trace", async () => {
    const created: string[] = []
    const updated: string[] = []
    const presenter = new ToolActivityPresenter({
      mode: "trace",
      showCalls: true,
      showArguments: true,
      showOutputFor: [],
      maxTraceEntries: 20,
    }, {
      create: async (text) => {
        created.push(text)
        return "message-1"
      },
      update: async (_messageId, text) => {
        updated.push(text)
      },
    })

    presenter.handle({ toolCallId: "call-1", tool: "read", status: "pending" })
    presenter.handle({
      toolCallId: "call-1",
      tool: "read",
      status: "running",
      description: "filePath=.../test_file.txt",
    })
    presenter.handle({ toolCallId: "call-1", tool: "read", status: "completed" })
    presenter.handle({ toolCallId: "call-2", tool: "grep", status: "running", description: "pattern=test" })
    presenter.handle({ toolCallId: "call-2", tool: "Search test files", status: "completed" })
    await presenter.flush()

    expect(created).toHaveLength(1)
    expect(updated.length).toBeGreaterThan(0)
    const final = updated.at(-1) || created.at(-1) || ""
    expect(final).toContain("[completed] filePath=.../test_file.txt [read]")
    expect(final).toContain("[completed] pattern=test [grep]")
    expect(final).not.toContain("[Search test files]")
  })

  test("continues long traces in additional editable messages", async () => {
    const created: string[] = []
    const updated: Array<{ id: string; text: string }> = []
    const presenter = new ToolActivityPresenter({
      mode: "trace",
      showCalls: true,
      showArguments: false,
      showOutputFor: [],
      maxTraceEntries: 2,
    }, {
      create: async (text) => {
        created.push(text)
        return `message-${created.length}`
      },
      update: async (id, text) => updated.push({ id, text }),
    })

    presenter.handle({ toolCallId: "call-1", tool: "read", status: "completed" })
    presenter.handle({ toolCallId: "call-2", tool: "grep", status: "completed" })
    await presenter.flush()
    presenter.handle({ toolCallId: "call-3", tool: "bash", status: "running" })
    await presenter.flush()

    expect(created).toHaveLength(2)
    expect(updated.some(({ id, text }) =>
      id === "message-1" && text.includes("part 1/2, continued")
    )).toBe(true)
    expect(created[1]).toContain("part 2/2, working")
    expect(created[1]).toContain("[bash]")
    expect(created[1]).not.toContain("[read]")
  })

  test("continues in a replacement message when editing fails", async () => {
    const created: string[] = []
    const updatedIds: string[] = []
    const errors: unknown[] = []
    let failNextUpdate = true
    const presenter = new ToolActivityPresenter({
      mode: "trace",
      showCalls: true,
      showArguments: false,
      showOutputFor: [],
    }, {
      create: async (text) => {
        created.push(text)
        return `message-${created.length}`
      },
      update: async (messageId) => {
        updatedIds.push(messageId)
        if (failNextUpdate) {
          failNextUpdate = false
          throw new Error("message is no longer editable")
        }
      },
      onError: (error) => errors.push(error),
    })

    presenter.handle({ toolCallId: "call-1", tool: "read", status: "pending" })
    await presenter.flush()
    presenter.handle({ toolCallId: "call-1", tool: "read", status: "running" })
    await presenter.flush()
    presenter.handle({ toolCallId: "call-1", tool: "read", status: "completed" })
    await presenter.flush()

    expect(created).toHaveLength(2)
    expect(updatedIds).toEqual(["message-1", "message-2"])
    expect(errors).toHaveLength(1)
  })

  test("renders only the current tool in status mode", async () => {
    let rendered = ""
    const presenter = new ToolActivityPresenter({
      mode: "status",
      showCalls: true,
      showArguments: false,
      showOutputFor: [],
    }, {
      create: async (text) => {
        rendered = text
        return "message-1"
      },
      update: async (_messageId, text) => { rendered = text },
    })

    presenter.handle({ toolCallId: "call-1", tool: "read", status: "completed" })
    presenter.handle({ toolCallId: "call-2", tool: "bash", status: "running" })
    await presenter.flush()

    expect(rendered).toContain("Current: [running] [bash]")
    expect(rendered).toContain("Completed: 1 tool")
    expect(rendered).not.toContain("[read]")
  })

  test("controller keeps connector event wiring mode-independent", async () => {
    const events: string[] = []
    let starts = 0
    const controller = new ToolActivityController({
      mode: "events",
      showCalls: true,
      showArguments: false,
      showOutputFor: [],
    }, {
      create: async () => "activity-1",
      update: async () => {},
    }, {
      sendEvent: async (message) => { events.push(message) },
      onToolStart: () => { starts++ },
    })

    await controller.handleActivity({ type: "tool_start", tool: "read", message: "[read]" })
    await controller.handleActivity({ type: "tool_start", tool: "read", message: "[read]" })

    expect(starts).toBe(2)
    expect(events).toEqual(["[read]"])
  })

  test("matches configured tool output by name substring", () => {
    const options = {
      showCalls: true,
      showArguments: false,
      showOutputFor: ["bash", "mcp__time"],
    }
    expect(shouldShowToolOutput("bash", options)).toBe(true)
    expect(shouldShowToolOutput("mcp__time__get_current_time", options)).toBe(true)
    expect(shouldShowToolOutput("read", options)).toBe(false)
  })
})

// =============================================================================
// RateLimiter
// =============================================================================

describe("RateLimiter", () => {
  let limiter: RateLimiter

  beforeEach(() => {
    limiter = new RateLimiter()
  })

  test("allows first message from user", () => {
    expect(limiter.check("user1", 5)).toBe(true)
  })

  test("blocks rapid subsequent messages", () => {
    expect(limiter.check("user1", 5)).toBe(true)
    expect(limiter.check("user1", 5)).toBe(false)
  })

  test("allows messages after limit expires", async () => {
    expect(limiter.check("user1", 0.1)).toBe(true) // 100ms limit
    
    await new Promise(resolve => setTimeout(resolve, 150))
    
    expect(limiter.check("user1", 0.1)).toBe(true)
  })

  test("tracks users independently", () => {
    expect(limiter.check("user1", 5)).toBe(true)
    expect(limiter.check("user2", 5)).toBe(true)
    expect(limiter.check("user1", 5)).toBe(false)
    expect(limiter.check("user2", 5)).toBe(false)
  })

  test("clear removes all tracking", () => {
    limiter.check("user1", 5)
    limiter.check("user2", 5)
    
    limiter.clear()
    
    expect(limiter.check("user1", 5)).toBe(true)
    expect(limiter.check("user2", 5)).toBe(true)
  })

  test("handles zero limit (always allow)", () => {
    expect(limiter.check("user1", 0)).toBe(true)
    expect(limiter.check("user1", 0)).toBe(true)
  })
})

// =============================================================================
// Shared helpers
// =============================================================================

class TestConnector extends BaseConnector<BaseSession> {
  constructor(allowedUsers?: string[]) {
    super({
      connector: "test",
      trigger: "!oc",
      botName: "Test",
      rateLimitSeconds: 5,
      sessionRetentionDays: 7,
      allowedUsers,
    })
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(): Promise<void> {}

  public canUserAccess(userId: string): boolean {
    return this.isUserAllowed(userId)
  }

  public startQuery(sessionId: string, abortFn?: () => void) {
    return this.markQueryActive(sessionId, abortFn)
  }

  public finishQuery(sessionId: string, handle?: ReturnType<TestConnector["startQuery"]>): void {
    this.markQueryDone(sessionId, handle)
  }

  public hasActiveQuery(sessionId: string): boolean {
    return this.isQueryActive(sessionId)
  }

  public cancelQuery(sessionId: string): boolean {
    return this.abortQuery(sessionId)
  }

  public isAborted(handle: ReturnType<TestConnector["startQuery"]>): boolean {
    return this.wasQueryAborted(handle)
  }

  public formatUserError(generic: string, err: unknown): string {
    return this.userErrorMessage(generic, err)
  }
}

describe("parseCsvList", () => {
  test("parses comma-separated values", () => {
    expect(parseCsvList("a, b ,c")).toEqual(["a", "b", "c"])
  })

  test("filters empty values", () => {
    expect(parseCsvList("a,, ,b")).toEqual(["a", "b"])
  })

  test("returns empty array for empty input", () => {
    expect(parseCsvList("")).toEqual([])
    expect(parseCsvList(undefined)).toEqual([])
  })
})

describe("BaseConnector allowlist", () => {
  test("allows all users when allowlist is empty", () => {
    const connector = new TestConnector([])
    expect(connector.canUserAccess("user-1")).toBe(true)
  })

  test("allows listed users", () => {
    const connector = new TestConnector(["user-1", "user-2"])
    expect(connector.canUserAccess("user-1")).toBe(true)
  })

  test("blocks unlisted users", () => {
    const connector = new TestConnector(["user-1", "user-2"])
    expect(connector.canUserAccess("user-3")).toBe(false)
  })
})

describe("BaseConnector active query handles", () => {
  test("tracks active queries", () => {
    const connector = new TestConnector()
    const handle = connector.startQuery("session-1")

    expect(connector.hasActiveQuery("session-1")).toBe(true)

    connector.finishQuery("session-1", handle)
    expect(connector.hasActiveQuery("session-1")).toBe(false)
  })

  test("stale query handle cannot clear newer active query", () => {
    const connector = new TestConnector()
    const oldHandle = connector.startQuery("session-1")
    const newHandle = connector.startQuery("session-1")

    connector.finishQuery("session-1", oldHandle)
    expect(connector.hasActiveQuery("session-1")).toBe(true)

    connector.finishQuery("session-1", newHandle)
    expect(connector.hasActiveQuery("session-1")).toBe(false)
  })

  test("abort marks handle as aborted and invokes abort callback", () => {
    const connector = new TestConnector()
    let aborted = false
    const handle = connector.startQuery("session-1", () => { aborted = true })

    expect(connector.cancelQuery("session-1")).toBe(true)

    expect(aborted).toBe(true)
    expect(connector.isAborted(handle)).toBe(true)
    expect(connector.hasActiveQuery("session-1")).toBe(false)
  })
})

// =============================================================================
// SessionManager
// =============================================================================

describe("SessionManager", () => {
  // Mock session type for testing
  interface MockSession extends BaseSession {
    extra?: string
  }

  let manager: SessionManager<MockSession>

  function createMockSession(overrides?: Partial<MockSession>): MockSession {
    return {
      client: {} as any, // Mock client
      createdAt: new Date(),
      messageCount: 0,
      lastActivity: new Date(),
      inputChars: 0,
      outputChars: 0,
      ...overrides,
    }
  }

  beforeEach(() => {
    manager = new SessionManager<MockSession>()
  })

  describe("CRUD operations", () => {
    test("get returns undefined for non-existent session", () => {
      expect(manager.get("nonexistent")).toBeUndefined()
    })

    test("set and get session", () => {
      const session = createMockSession({ extra: "test" })
      manager.set("session1", session)
      
      const retrieved = manager.get("session1")
      expect(retrieved).toBe(session)
      expect(retrieved?.extra).toBe("test")
    })

    test("has returns correct boolean", () => {
      expect(manager.has("session1")).toBe(false)
      
      manager.set("session1", createMockSession())
      
      expect(manager.has("session1")).toBe(true)
    })

    test("delete removes session", () => {
      manager.set("session1", createMockSession())
      expect(manager.has("session1")).toBe(true)
      
      const result = manager.delete("session1")
      
      expect(result).toBe(true)
      expect(manager.has("session1")).toBe(false)
    })

    test("delete returns false for non-existent session", () => {
      expect(manager.delete("nonexistent")).toBe(false)
    })

    test("clear removes all sessions", () => {
      manager.set("session1", createMockSession())
      manager.set("session2", createMockSession())
      
      manager.clear()
      
      expect(manager.has("session1")).toBe(false)
      expect(manager.has("session2")).toBe(false)
    })
  })

  describe("trackMessage", () => {
    test("updates session stats", () => {
      const session = createMockSession({
        messageCount: 5,
        inputChars: 100,
        outputChars: 200,
      })
      manager.set("session1", session)

      manager.trackMessage("session1", 50, 100)

      const updated = manager.get("session1")!
      expect(updated.messageCount).toBe(6)
      expect(updated.inputChars).toBe(150)
      expect(updated.outputChars).toBe(300)
    })

    test("updates lastActivity", () => {
      const oldDate = new Date(Date.now() - 10000)
      const session = createMockSession({ lastActivity: oldDate })
      manager.set("session1", session)

      manager.trackMessage("session1", 10, 20)

      const updated = manager.get("session1")!
      expect(updated.lastActivity.getTime()).toBeGreaterThan(oldDate.getTime())
    })

    test("does nothing for non-existent session", () => {
      // Should not throw
      manager.trackMessage("nonexistent", 100, 200)
    })
  })

  describe("getStats", () => {
    test("returns null for non-existent session", () => {
      expect(manager.getStats("nonexistent")).toBeNull()
    })

    test("calculates correct stats", () => {
      const now = Date.now()
      const fiveMinutesAgo = new Date(now - 5 * 60 * 1000)
      const twoMinutesAgo = new Date(now - 2 * 60 * 1000)

      const session = createMockSession({
        createdAt: fiveMinutesAgo,
        lastActivity: twoMinutesAgo,
        inputChars: 1000,  // 250 tokens
        outputChars: 2000, // 500 tokens
      })
      manager.set("session1", session)

      const stats = manager.getStats("session1")!

      expect(stats.age).toBe(5)
      expect(stats.lastActivity).toBe(2)
      expect(stats.inputTokens).toBe(250)
      expect(stats.outputTokens).toBe(500)
      expect(stats.totalTokens).toBe(750)
      expect(parseFloat(stats.contextPercent)).toBeCloseTo(0.375, 1)
    })

    test("handles zero chars", () => {
      const session = createMockSession({
        inputChars: 0,
        outputChars: 0,
      })
      manager.set("session1", session)

      const stats = manager.getStats("session1")!

      expect(stats.inputTokens).toBe(0)
      expect(stats.outputTokens).toBe(0)
      expect(stats.totalTokens).toBe(0)
      expect(stats.contextPercent).toBe("0.00")
    })
  })
})

// =============================================================================
// CommandHandler
// =============================================================================

describe("CommandHandler", () => {
  describe("formatStatusMessage", () => {
    test("formats status with all fields", () => {
      const stats: SessionStats = {
        age: 10,
        lastActivity: 2,
        inputTokens: 1000,
        outputTokens: 2000,
        totalTokens: 3000,
        contextPercent: "1.50",
      }

      const result = CommandHandler.formatStatusMessage(15, stats)

      expect(result).toContain("Messages: 15")
      expect(result).toContain("Age: 10 min")
      expect(result).toContain("Last active: 2 min ago")
      expect(result).toContain("3,000") // totalTokens with locale formatting
      expect(result).toContain("1.50%")
      expect(result).toContain("Input:")
      expect(result).toContain("Output:")
    })

    test("formats large numbers with locale separators", () => {
      const stats: SessionStats = {
        age: 60,
        lastActivity: 5,
        inputTokens: 50000,
        outputTokens: 100000,
        totalTokens: 150000,
        contextPercent: "75.00",
      }

      const result = CommandHandler.formatStatusMessage(100, stats)

      expect(result).toContain("150,000")
    })
  })

  describe("formatHelpMessage", () => {
    test("includes trigger and bot name", () => {
      const result = CommandHandler.formatHelpMessage("!oc", "TestBot")

      expect(result).toContain("TestBot")
      expect(result).toContain("!oc")
      expect(result).toContain("/status")
      expect(result).toContain("/clear")
      expect(result).toContain("/help")
    })
  })

  describe("formatNoSessionMessage", () => {
    test("returns appropriate message", () => {
      const result = CommandHandler.formatNoSessionMessage()
      expect(result.toLowerCase()).toContain("no")
      expect(result.toLowerCase()).toContain("session")
    })
  })

  describe("formatSessionClearedMessage", () => {
    test("returns appropriate message", () => {
      const result = CommandHandler.formatSessionClearedMessage()
      expect(result.toLowerCase()).toContain("cleared")
    })
  })

  describe("formatUnknownCommandMessage", () => {
    test("includes the unknown command", () => {
      const result = CommandHandler.formatUnknownCommandMessage("/foo")
      expect(result).toContain("/foo")
      expect(result.toLowerCase()).toContain("unknown")
    })
  })

  describe("formatConnectionErrorMessage", () => {
    test("returns appropriate error message", () => {
      const result = CommandHandler.formatConnectionErrorMessage()
      expect(result.toLowerCase()).toContain("sorry")
      expect(result.toLowerCase()).toContain("connect")
    })
  })

  describe("formatProcessingErrorMessage", () => {
    test("returns appropriate error message", () => {
      const result = CommandHandler.formatProcessingErrorMessage()
      expect(result.toLowerCase()).toContain("sorry")
      expect(result.toLowerCase()).toContain("wrong")
    })
  })
})

// =============================================================================
// EventDeduplicator
// =============================================================================

import { EventDeduplicator } from "../../src/connector-base"

describe("EventDeduplicator", () => {
  let dedup: EventDeduplicator

  beforeEach(() => {
    dedup = new EventDeduplicator()
  })

  test("allows first occurrence of an event", () => {
    expect(dedup.isDuplicate("event-1")).toBe(false)
  })

  test("blocks duplicate events", () => {
    dedup.isDuplicate("event-1")
    expect(dedup.isDuplicate("event-1")).toBe(true)
  })

  test("tracks different events independently", () => {
    expect(dedup.isDuplicate("event-1")).toBe(false)
    expect(dedup.isDuplicate("event-2")).toBe(false)
    expect(dedup.isDuplicate("event-1")).toBe(true)
    expect(dedup.isDuplicate("event-2")).toBe(true)
  })

  test("evicts entries older than maxAgeMs", async () => {
    // Use a very short TTL for testing
    const fastDedup = new EventDeduplicator(100) // 100ms
    fastDedup.isDuplicate("event-1")
    expect(fastDedup.isDuplicate("event-1")).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 150))

    // After TTL, should be treated as new
    expect(fastDedup.isDuplicate("event-1")).toBe(false)
  })

  test("clear removes all tracking", () => {
    dedup.isDuplicate("event-1")
    dedup.isDuplicate("event-2")
    expect(dedup.size).toBe(2)

    dedup.clear()

    expect(dedup.size).toBe(0)
    expect(dedup.isDuplicate("event-1")).toBe(false)
  })

  test("size reflects tracked event count", () => {
    expect(dedup.size).toBe(0)
    dedup.isDuplicate("a")
    dedup.isDuplicate("b")
    dedup.isDuplicate("c")
    expect(dedup.size).toBe(3)
    // Duplicate does not increase size
    dedup.isDuplicate("a")
    expect(dedup.size).toBe(3)
  })
})

// =============================================================================
// buildUserErrorMessage / BaseConnector.userErrorMessage
// =============================================================================

describe("buildUserErrorMessage", () => {
  const generic = "Could not list saved ACP sessions."

  test("returns the generic message verbatim when verbose is false", () => {
    expect(buildUserErrorMessage(generic, new Error("boom"), false))
      .toBe(generic)
    expect(buildUserErrorMessage(generic, "string error", false))
      .toBe(generic)
    expect(buildUserErrorMessage(generic, { code: 42 }, false))
      .toBe(generic)
  })

  test("appends Error.message when verbose is true", () => {
    expect(buildUserErrorMessage(generic, new Error("backend unreachable"), true))
      .toBe(`${generic}\nbackend unreachable`)
  })

  test("stringifies non-Error values when verbose is true", () => {
    expect(buildUserErrorMessage(generic, "plain string", true))
      .toBe(`${generic}\nplain string`)
    expect(buildUserErrorMessage(generic, 42, true))
      .toBe(`${generic}\n42`)
    expect(buildUserErrorMessage(generic, { code: 42 }, true))
      .toBe(`${generic}\n[object Object]`)
  })

  test("collapses whitespace in the appended detail", () => {
    const err = new Error("line one\n\tline two   line\n   three")
    expect(buildUserErrorMessage(generic, err, true))
      .toBe(`${generic}\nline one line two line three`)
  })

  test("returns the generic message when the error detail is empty", () => {
    expect(buildUserErrorMessage(generic, new Error("   \n\t  "), true))
      .toBe(generic)
    expect(buildUserErrorMessage(generic, "", true)).toBe(generic)
  })

  test("truncates very long error messages to USER_ERROR_DETAIL_MAX_LENGTH", () => {
    const longMessage = "x".repeat(USER_ERROR_DETAIL_MAX_LENGTH * 5)
    const result = buildUserErrorMessage(generic, new Error(longMessage), true)
    // detail line is bounded; total message is generic + "\n" + bounded detail
    const detailLine = result.slice(generic.length + 1)
    expect(detailLine.length).toBeLessThanOrEqual(USER_ERROR_DETAIL_MAX_LENGTH)
    expect(detailLine.endsWith("...")).toBe(true)
    expect(detailLine.length).toBe(USER_ERROR_DETAIL_MAX_LENGTH)
    // The body before the trailing ellipsis is exactly maxLength - 3 characters
    expect(detailLine.slice(0, -3)).toBe("x".repeat(USER_ERROR_DETAIL_MAX_LENGTH - 3))
  })

  test("does not truncate messages that fit within the limit", () => {
    const detail = "y".repeat(USER_ERROR_DETAIL_MAX_LENGTH - 1)
    const result = buildUserErrorMessage(generic, new Error(detail), true)
    expect(result).toBe(`${generic}\n${detail}`)
    expect(result.endsWith("...")).toBe(false)
  })

  test("truncates after collapsing whitespace", () => {
    const detail = "a".repeat(USER_ERROR_DETAIL_MAX_LENGTH - 5) + " " + "b".repeat(200)
    const result = buildUserErrorMessage(generic, new Error(detail), true)
    const detailLine = result.slice(generic.length + 1)
    // Collapsed form stays within maxLength after the "..." suffix
    expect(detailLine.length).toBeLessThanOrEqual(USER_ERROR_DETAIL_MAX_LENGTH)
    expect(detailLine.endsWith("...")).toBe(true)
  })

  test("respects a custom maxLength argument", () => {
    const longMessage = "z".repeat(200)
    const result = buildUserErrorMessage(generic, new Error(longMessage), true, 50)
    const detailLine = result.slice(generic.length + 1)
    expect(detailLine.length).toBe(50)
    expect(detailLine.endsWith("...")).toBe(true)
  })
})

describe("BaseConnector.userErrorMessage", () => {
  const generic = "Could not list saved ACP sessions."

  test("honors verboseErrors=false (default) by returning the generic message", () => {
    const connector = new TestConnector()
    expect(connector.formatUserError(generic, new Error("backend blew up")))
      .toBe(generic)
  })

  test("appends the error detail when verboseErrors is enabled", () => {
    // Toggle the instance flag via the protected field using a small hack.
    // We do not expose a setter, so we cast through `unknown` to set the
    // private field for the test only.
    const connector = new TestConnector()
    ;(connector as unknown as { verboseErrors: boolean }).verboseErrors = true
    expect(connector.formatUserError(generic, new Error("backend blew up")))
      .toBe(`${generic}\nbackend blew up`)
  })

  test("truncates the appended detail through the instance method", () => {
    const connector = new TestConnector()
    ;(connector as unknown as { verboseErrors: boolean }).verboseErrors = true
    const longMessage = "q".repeat(USER_ERROR_DETAIL_MAX_LENGTH * 10)
    const result = connector.formatUserError(generic, new Error(longMessage))
    expect(result.length).toBeLessThanOrEqual(generic.length + 1 + USER_ERROR_DETAIL_MAX_LENGTH)
    expect(result.endsWith("...")).toBe(true)
  })
})
