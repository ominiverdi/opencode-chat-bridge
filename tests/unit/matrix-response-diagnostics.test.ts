import { describe, expect, test } from "bun:test"
import { diagnoseEmptyResponse } from "../../connectors/matrix-response-diagnostics"

describe("Matrix empty ACP response diagnostics", () => {
  test("identifies an ACP response with no text updates", () => {
    expect(diagnoseEmptyResponse("", "", "")).toEqual({
      source: "acp-no-text",
      acpChars: 0,
      bridgeChars: 0,
      cleanChars: 0,
    })
  })

  test("identifies ACP text lost by the bridge listener", () => {
    expect(diagnoseEmptyResponse("answer", "", "")).toEqual({
      source: "bridge-capture-lost",
      acpChars: 6,
      bridgeChars: 0,
      cleanChars: 0,
    })
  })

  test("identifies content removed during bridge processing", () => {
    expect(diagnoseEmptyResponse("marker", "marker", "")).toEqual({
      source: "bridge-processing-removed",
      acpChars: 6,
      bridgeChars: 6,
      cleanChars: 0,
    })
  })

  test("returns null for a visible response", () => {
    expect(diagnoseEmptyResponse("answer", "answer", "answer")).toBeNull()
  })
})
