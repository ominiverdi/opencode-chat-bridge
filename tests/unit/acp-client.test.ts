import { describe, expect, test } from "bun:test"
import { ACPClient } from "../../src/acp-client"

describe("ACPClient session updates", () => {
  test("maps Ferrum tool start and completion updates", () => {
    const client = new ACPClient()
    const activity: string[] = []
    const updates: string[] = []
    client.on("activity", (event) => activity.push(event.type))
    client.on("update", (event) => updates.push(event.type))

    ;(client as any).handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "write",
        rawInput: { path: "generated/result.txt" },
      },
    })
    ;(client as any).handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        title: "write",
        status: "completed",
        content: [{ content: { type: "text", text: "wrote file" } }],
      },
    })

    expect(activity).toEqual(["tool_start", "tool_end"])
    expect(updates).toEqual(["tool_call", "tool_result"])
  })

  test("prefers arguments from an immediate in-progress update", () => {
    const client = new ACPClient()
    const activity: Array<{ tool?: string; description?: string }> = []
    const revisions: Array<{ toolCallId: string; status: string; description?: string }> = []
    client.on("tool_activity", (event) => revisions.push(event))
    client.on("activity", (event) => {
      if (event.type === "tool_start") activity.push(event)
    })

    ;(client as any).handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-search",
        title: "websearch",
      },
    })
    expect(activity).toHaveLength(0)

    ;(client as any).handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-search",
        title: "Exa Web Search",
        status: "in_progress",
        rawInput: { query: "current time in Barcelona", numResults: 5 },
      },
    })

    expect(activity).toHaveLength(1)
    expect(activity[0].tool).toBe("Exa Web Search")
    expect(activity[0].description).toContain("query=current time in Barcelona")
    expect(activity[0].description).toContain("numResults=5")
    expect(revisions.map((event) => event.status)).toEqual(["pending", "running"])
    expect(revisions[1].toolCallId).toBe("call-search")
    expect(revisions[1].description).toContain("query=current time in Barcelona")
  })

  test("preserves the end of long path arguments", () => {
    const client = new ACPClient()
    let description = ""
    client.on("activity", (event) => {
      if (event.type === "tool_start") description = event.description || ""
    })

    ;(client as any).handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-read",
        title: "read",
        rawInput: {
          filePath: "/home/user/.cache/opencode-chat-bridge/sessions/whatsapp/a-very-long-session-identifier/generated/demo_log.txt",
        },
      },
    })

    expect(description).toStartWith("filePath=...")
    expect(description).toEndWith("/generated/demo_log.txt")
  })

  test("compacts multiline arguments and omits redundant descriptions", () => {
    const client = new ACPClient()
    let description = ""
    client.on("activity", (event) => {
      if (event.type === "tool_start") description = event.description || ""
    })

    ;(client as any).handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-bash",
        title: "bash",
        rawInput: {
          command: "printf 'first\\nsecond'\n> output.txt",
          description: "Create the output file",
          workdir: "/tmp/work",
        },
      },
    })

    expect(description).toContain("command=printf 'first\\nsecond' > output.txt")
    expect(description).toContain("workdir=/tmp/work")
    expect(description).not.toContain("description=")
  })

  test("flushes an argument-less tool start when the tool completes", () => {
    const client = new ACPClient()
    const activity: Array<{ type: string; tool?: string }> = []
    client.on("activity", (event) => activity.push(event))

    ;(client as any).handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-no-args",
        title: "status",
      },
    })
    ;(client as any).handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-no-args",
        title: "status",
        status: "completed",
      },
    })

    expect(activity.map((event) => event.type)).toEqual(["tool_start", "tool_end"])
    expect(activity[0].tool).toBe("status")
  })

  test("ignores unknown update variants", () => {
    const client = new ACPClient()
    expect(() => (client as any).handleSessionUpdate({
      update: { sessionUpdate: "future_update_variant", value: true },
    })).not.toThrow()
  })
})
