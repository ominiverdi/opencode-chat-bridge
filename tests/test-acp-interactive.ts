#!/usr/bin/env bun
/**
 * Simple ACP interaction viewer
 * Shows all JSON-RPC messages between client and OpenCode
 * 
 * Usage: bun test-acp-interactive.ts
 */

import { spawn } from "child_process"

const acp = spawn("opencode", ["acp"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: process.cwd(),
})

let requestId = 0

// Pending response handlers
const pending = new Map<number, (msg: any) => void>()

// Helper to send JSON-RPC and wait for response
function send(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve) => {
    const id = ++requestId
    const msg = { jsonrpc: "2.0", id, method, params }
    const line = JSON.stringify(msg)
    
    console.log("\n>>> SENDING >>>")
    console.log(JSON.stringify(msg, null, 2))
    
    pending.set(id, resolve)
    acp.stdin.write(line + "\n")
  })
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
      console.log("\n<<< RECEIVED <<<")
      console.log(JSON.stringify(msg, null, 2))
      
      // Resolve pending request
      if (msg.id && pending.has(msg.id)) {
        const resolve = pending.get(msg.id)!
        pending.delete(msg.id)
        resolve(msg)
      }
    } catch {
      console.log("\n<<< RAW <<<")
      console.log(line)
    }
  }
})

acp.stderr.on("data", (data) => {
  console.log("\n[STDERR]", data.toString())
})

acp.on("close", (code) => {
  console.log("\n[ACP CLOSED] exit code:", code)
  process.exit(0)
})

// Run the interaction sequence
async function main() {
  console.log("=".repeat(60))
  console.log("ACP INTERACTION VIEWER")
  console.log("=".repeat(60))
  
  // Wait for ACP to start
  await sleep(500)
  
  // Step 1: Initialize
  console.log("\n" + "=".repeat(60))
  console.log("STEP 1: Initialize connection")
  console.log("=".repeat(60))
  const initResult = await send("initialize", {
    protocolVersion: 1,
  })
  
  if (initResult.error) {
    console.log("[ERROR] Initialize failed")
    acp.kill()
    return
  }
  
  // Step 2: Create session
  console.log("\n" + "=".repeat(60))
  console.log("STEP 2: Create a new session")
  console.log("=".repeat(60))
  const sessionResult = await send("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  })
  
  if (sessionResult.error || !sessionResult.result?.sessionId) {
    console.log("[ERROR] Session creation failed")
    acp.kill()
    return
  }
  
  const sessionId = sessionResult.result.sessionId
  console.log("\n[SESSION ID]", sessionId)
  
  // Step 3: Send a prompt
  console.log("\n" + "=".repeat(60))
  console.log("STEP 3: Send a prompt")
  console.log("=".repeat(60))
  
  const promptResult = await send("session/prompt", {
    sessionId: sessionId,
    prompt: [
      { type: "text", text: "Say hello in exactly 5 words." }
    ],
  })
  
  console.log("\n" + "=".repeat(60))
  console.log("DONE - Closing ACP")
  console.log("=".repeat(60))
  
  acp.kill()
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch(console.error)
