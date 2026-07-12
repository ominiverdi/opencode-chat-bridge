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

  test("ignores unknown update variants", () => {
    const client = new ACPClient()
    expect(() => (client as any).handleSessionUpdate({
      update: { sessionUpdate: "future_update_variant", value: true },
    })).not.toThrow()
  })
})
