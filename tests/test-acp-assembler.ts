#!/usr/bin/env bun
/**
 * ACP Response Assembler
 * Collects streaming chunks and displays them as coherent content blocks
 * 
 * Usage: bun tests/test-acp-assembler.ts
 */

import { spawn } from "child_process"

const acp = spawn("opencode", ["acp"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: process.cwd(),
})

let requestId = 0

// Response state
let currentText = ""
let currentThought = ""
let toolCalls: Array<{ name: string; args: any; result?: string; id?: string }> = []

// Pending response handlers
const pending = new Map<number, (msg: any) => void>()

// Helper to send JSON-RPC and wait for response
function send(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve) => {
    const id = ++requestId
    const msg = { jsonrpc: "2.0", id, method, params }
    pending.set(id, resolve)
    acp.stdin.write(JSON.stringify(msg) + "\n")
  })
}

// Process session updates
function handleUpdate(params: any) {
  const update = params.update
  
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      // Accumulate text chunks
      if (update.content?.type === "text") {
        currentText += update.content.text
        // Print dots for progress
        process.stdout.write(".")
      }
      break
    
    case "agent_thought_chunk":
      // Accumulate thinking/reasoning chunks (silent)
      if (update.content?.type === "text") {
        currentThought += update.content.text
      }
      process.stdout.write(".")
      break
      
    case "tool_call":
      // Tool execution started
      const toolName = update.title || update.name || "unknown"
      const toolId = update.toolCallId
      const toolArgs = update.rawInput || update.arguments || {}
      console.log("\n[TOOL]", toolName, `(${update.status})`)
      if (Object.keys(toolArgs).length > 0) {
        console.log("  Args:", JSON.stringify(toolArgs))
      }
      toolCalls.push({ name: toolName, args: toolArgs, id: toolId })
      break
      
    case "tool_call_update":
      // Tool execution progress/result
      if (update.result) {
        const lastTool = toolCalls[toolCalls.length - 1]
        if (lastTool) {
          lastTool.result = update.result
        }
        console.log("[TOOL RESULT]", update.result.substring(0, 200) + (update.result.length > 200 ? "..." : ""))
      }
      break
      
    case "available_commands_update":
      // Commands available - usually at end
      break
      
    default:
      // Silently ignore other update types
      break
  }
}

// Parse incoming messages
let buffer = ""
acp.stdout.on("data", (data) => {
  buffer += data.toString()
  const lines = buffer.split("\n")
  buffer = lines.pop() || ""
  
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      
      // Handle notifications (no id)
      if (!msg.id && msg.method === "session/update") {
        handleUpdate(msg.params)
        continue
      }
      
      // Resolve pending request
      if (msg.id && pending.has(msg.id)) {
        const resolve = pending.get(msg.id)!
        pending.delete(msg.id)
        resolve(msg)
      }
    } catch {
      // Ignore parse errors
    }
  }
})

acp.stderr.on("data", (data) => {
  const text = data.toString()
  if (!text.includes("Error handling")) {
    console.error("\n[STDERR]", text)
  }
})

acp.on("close", (code) => {
  process.exit(0)
})

// Format the final response
function formatResponse() {
  console.log("\n")
  console.log("=".repeat(60))
  console.log("ASSEMBLED RESPONSE")
  console.log("=".repeat(60))
  
  if (currentThought && currentThought.trim()) {
    console.log("\n--- Thinking ---\n")
    console.log(currentThought.substring(0, 500) + (currentThought.length > 500 ? "..." : ""))
  }
  
  if (toolCalls.length > 0) {
    console.log("\n--- Tool Calls ---")
    for (const tool of toolCalls) {
      console.log(`\n[${tool.name}]`)
      if (tool.args) {
        console.log("Input:", JSON.stringify(tool.args))
      }
      if (tool.result) {
        console.log("Output:", tool.result.substring(0, 500) + (tool.result.length > 500 ? "..." : ""))
      }
    }
  }
  
  if (currentText) {
    console.log("\n--- Response Text ---\n")
    console.log(currentText)
  }
  
  console.log("\n" + "=".repeat(60))
}

// Main
async function main() {
  const prompt = process.argv[2] || "What time is it in Madrid? Use the time tool."
  
  console.log("=".repeat(60))
  console.log("ACP RESPONSE ASSEMBLER")
  console.log("=".repeat(60))
  console.log("\nPrompt:", prompt)
  console.log("\nStreaming response", "")
  
  // Wait for ACP to start
  await sleep(500)
  
  // Initialize
  const initResult = await send("initialize", { protocolVersion: 1 })
  if (initResult.error) {
    console.error("Initialize failed:", initResult.error)
    acp.kill()
    return
  }
  
  // Create session with MCP time server
  const sessionResult = await send("session/new", {
    cwd: process.cwd(),
    mcpServers: [
      {
        name: "time",
        command: "opencode",
        args: ["mcp", "time"],
        env: []
      }
    ],
  })
  
  if (sessionResult.error || !sessionResult.result?.sessionId) {
    console.error("Session creation failed:", sessionResult.error)
    acp.kill()
    return
  }
  
  const sessionId = sessionResult.result.sessionId
  
  // Send prompt and wait for completion
  const promptResult = await send("session/prompt", {
    sessionId: sessionId,
    prompt: [{ type: "text", text: prompt }],
  })
  
  // Format and display
  formatResponse()
  
  acp.kill()
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch(console.error)
