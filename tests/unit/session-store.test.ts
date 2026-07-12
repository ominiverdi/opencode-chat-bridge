import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { ACPSessionStore } from "../../src/session-store"

let tempDir: string
let store: ACPSessionStore

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-bridge-store-"))
  store = new ACPSessionStore(path.join(tempDir, "state", "sessions.json"))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("ACPSessionStore", () => {
  test("persists and replaces a thread mapping atomically", async () => {
    await store.set({
      connector: "matrix",
      threadId: "room:thread",
      sessionId: "first",
      cwd: "/tmp/workspace",
      backendId: "ferrum",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    await store.set({
      connector: "matrix",
      threadId: "room:thread",
      sessionId: "second",
      cwd: "/tmp/workspace",
      backendId: "ferrum",
      updatedAt: "2026-01-02T00:00:00.000Z",
    })

    expect(store.get("matrix", "room:thread")?.sessionId).toBe("second")
    expect(JSON.parse(fs.readFileSync(store.filePath, "utf-8")).sessions).toHaveLength(1)
    expect(fs.statSync(store.filePath).mode & 0o777).toBe(0o600)
  })

  test("isolates connectors sharing the same thread id", async () => {
    const base = {
      threadId: "same",
      cwd: "/tmp/workspace",
      backendId: "ferrum",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    await store.set({ ...base, connector: "matrix", sessionId: "matrix-session" })
    await store.set({ ...base, connector: "slack", sessionId: "slack-session" })

    expect(store.get("matrix", "same")?.sessionId).toBe("matrix-session")
    expect(store.get("slack", "same")?.sessionId).toBe("slack-session")
  })

  test("deletes only the selected mapping", async () => {
    const base = {
      connector: "matrix",
      cwd: "/tmp/workspace",
      backendId: "ferrum",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    await store.set({ ...base, threadId: "one", sessionId: "one" })
    await store.set({ ...base, threadId: "two", sessionId: "two" })

    await store.delete("matrix", "one")

    expect(store.get("matrix", "one")).toBeNull()
    expect(store.get("matrix", "two")?.sessionId).toBe("two")
  })

  test("rejects malformed stores instead of overwriting them", () => {
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true })
    fs.writeFileSync(store.filePath, "{}")
    expect(() => store.get("matrix", "thread")).toThrow("Invalid ACP session store")
  })
})
