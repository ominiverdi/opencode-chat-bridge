import { describe, expect, test } from "bun:test"
import { EventEmitter } from "events"
import { MatrixConnector } from "../../connectors/matrix"

class FakeACPClient extends EventEmitter {
  cancelled = false

  constructor(
    private response: string,
    private emitChunks = true,
  ) {
    super()
  }

  async prompt(): Promise<string> {
    if (this.response && this.emitChunks) this.emit("chunk", this.response)
    return this.response
  }

  cancel(): void {
    this.cancelled = true
  }
}

function roomSession(client: FakeACPClient) {
  return {
    client,
    createdAt: new Date(),
    lastActivity: new Date(),
    messageCount: 0,
    inputChars: 0,
    outputChars: 0,
    lastEventIds: new Map<string, string>(),
  }
}

const context = {
  roomId: "!room:example.org",
  sender: "@user:example.org",
  eventId: "$event",
  threadRootEventId: null,
  replyThreadRootId: "$event",
  sessionId: "!room:example.org",
}

function fakeConnector(firstResponse: string, retryResponse: string, firstEmitsChunks = true) {
  const first = roomSession(new FakeACPClient(firstResponse, firstEmitsChunks))
  const retry = roomSession(new FakeACPClient(retryResponse))
  let current = first
  const replies: string[] = []
  const logs: string[] = []
  let retries = 0

  return {
    connector: {
      isQueryActive: () => false,
      markQueryActive: () => ({ sessionId: context.sessionId, id: 1, aborted: false, abort: () => {} }),
      markQueryDone: () => {},
      getOrCreateSession: async () => first,
      recreateACPSession: async () => {
        retries++
        current = retry
        return retry
      },
      createSession: () => first,
      sessionManager: { get: () => current },
      sendReply: async (_context: unknown, text: string) => {
        replies.push(text)
        return `$reply-${replies.length}`
      },
      sendNoticeReply: async () => {},
      createToolActivityMessage: async () => "$tool",
      updateToolActivityMessage: async () => {},
      sendImageFromBase64: async () => {},
      sendImageFromFile: async () => {},
      log: (message: string) => logs.push(message),
      logError: (message: string) => logs.push(message),
    },
    replies,
    logs,
    retryCount: () => retries,
  }
}

async function processQuery(fake: ReturnType<typeof fakeConnector>): Promise<void> {
  await (MatrixConnector.prototype as any).processQuery.call(fake.connector, context, "summarize")
}

describe("Matrix empty ACP responses", () => {
  test("retries once with a fresh session and sends the recovered response", async () => {
    const fake = fakeConnector("", "recovered answer")

    await processQuery(fake)

    expect(fake.retryCount()).toBe(1)
    expect(fake.replies).toEqual(["recovered answer"])
    expect(fake.logs.some((line) => line.includes("[DONE]") && line.includes("16 chars"))).toBe(true)
    expect(fake.logs.some((line) => line.includes("[FAIL]"))).toBe(false)
  })

  test("recovers and diagnoses ACP text missed by the bridge listener", async () => {
    const fake = fakeConnector("recovered answer", "", false)

    await processQuery(fake)

    expect(fake.retryCount()).toBe(0)
    expect(fake.replies).toEqual(["recovered answer"])
    expect(fake.logs.some((line) => line.includes("source=bridge-capture-lost"))).toBe(true)
    expect(fake.logs.some((line) => line.includes("[DONE]"))).toBe(true)
  })

  test("reports a visible failure when the retry is also empty", async () => {
    const fake = fakeConnector("", "")

    await processQuery(fake)

    expect(fake.retryCount()).toBe(1)
    expect(fake.replies).toEqual([
      "Sorry, the ACP backend completed without returning a usable response. Please try again.",
    ])
    expect(fake.logs.some((line) => line.includes("[FAIL]") && line.includes("source=acp-no-text"))).toBe(true)
    expect(fake.logs.some((line) => line.includes("[DONE]"))).toBe(false)
  })
})
