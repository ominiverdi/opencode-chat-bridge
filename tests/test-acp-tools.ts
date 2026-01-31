#!/usr/bin/env bun
/**
 * ACP Tools Lister
 * Lists all available tools by asking the model
 * 
 * Usage: bun tests/test-acp-tools.ts
 */

import { spawn } from "child_process"

const acp = spawn("opencode", ["acp"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: process.cwd(),
})

let requestId = 0
const pending = new Map<number, (msg: any) => void>()
let responseText = ""
let toolsSeen = new Set<string>()
let promptDone = false

function send(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve) => {
    const id = ++requestId
    const msg = { jsonrpc: "2.0", id, method, params }
    pending.set(id, resolve)
    acp.stdin.write(JSON.stringify(msg) + "\n")
  })
}

let buffer = ""
acp.stdout.on("data", (data) => {
  buffer += data.toString()
  const lines = buffer.split("\n")
  buffer = lines.pop() || ""
  
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      
      // Capture tool calls from session updates
      if (msg.method === "session/update") {
        const update = msg.params?.update
        if (update?.sessionUpdate === "tool_call" && update?.title) {
          toolsSeen.add(update.title)
          process.stdout.write("[" + update.title + "] ")
        }
        if (update?.sessionUpdate === "agent_message_chunk" && update?.content?.text) {
          responseText += update.content.text
          process.stdout.write(".")
        }
      }
      
      if (msg.id && pending.has(msg.id)) {
        const resolve = pending.get(msg.id)!
        pending.delete(msg.id)
        promptDone = true
        resolve(msg)
      }
    } catch {}
  }
})

acp.on("close", () => process.exit(0))

async function main() {
  console.log("=".repeat(60))
  console.log("ACP TOOLS LISTER")
  console.log("=".repeat(60))
  
  await sleep(500)
  
  // Initialize
  const initResult = await send("initialize", { protocolVersion: 1 })
  if (initResult.error) {
    console.error("Initialize failed:", initResult.error)
    acp.kill()
    return
  }
  
  console.log("\nOpenCode Version:", initResult.result?.agentInfo?.version)
  
  // Create session
  const sessionResult = await send("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  })
  
  if (sessionResult.error) {
    console.error("Session creation failed:", sessionResult.error)
    acp.kill()
    return
  }
  
  const sessionId = sessionResult.result.sessionId
  console.log("Session ID:", sessionId)
  console.log("\nQuerying available tools...\n")
  
  // Ask for tool list with timeout
  const promptPromise = send("session/prompt", {
    sessionId,
    prompt: [{ 
      type: "text", 
      text: "What tools do you have access to? Don't use any tools, just list from your system prompt. List the function/tool names only." 
    }],
  })
  
  // Wait max 30 seconds
  await Promise.race([
    promptPromise,
    sleep(30000)
  ])
  
  console.log("\n\n" + "=".repeat(60))
  console.log("AVAILABLE TOOLS (from model response)")
  console.log("=".repeat(60))
  console.log(responseText || "(no response captured)")
  
  if (toolsSeen.size > 0) {
    console.log("\n" + "=".repeat(60))
    console.log("TOOLS OBSERVED IN USE")
    console.log("=".repeat(60))
    Array.from(toolsSeen).sort().forEach(t => console.log(`  - ${t}`))
  }
  
  console.log("\n" + "=".repeat(60))
  
  acp.kill()
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch(console.error)
