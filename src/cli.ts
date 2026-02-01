#!/usr/bin/env bun
/**
 * OpenCode Chat CLI
 * Interactive CLI for chatting with OpenCode via ACP
 * 
 * SECURITY: The default agent (chat-bridge) is defined in opencode.json
 * with permission-based tool restrictions. This is enforced at the
 * OpenCode level, not via prompts, making it resistant to prompt injection.
 * 
 * Usage: 
 *   bun src/cli.ts                    # Interactive mode
 *   bun src/cli.ts "Your prompt"      # Single prompt
 *   bun src/cli.ts --no-images        # Disable image display
 */

import { ACPClient } from "./acp-client"
import * as readline from "readline"
import { spawnSync } from "child_process"
import { existsSync } from "fs"

// Check if chafa is available for image display
const hasChafa = spawnSync("which", ["chafa"], { encoding: "utf-8" }).status === 0

/**
 * Display an image in the terminal using chafa
 */
function displayImage(imagePath: string): void {
  if (!hasChafa) {
    console.log(`[Image: ${imagePath}]`)
    return
  }
  
  if (!existsSync(imagePath)) {
    console.log(`[Image not found: ${imagePath}]`)
    return
  }
  
  // Use chafa to display the image directly to stdout (not captured)
  // --size limits dimensions, --format=symbols for compatibility
  const result = spawnSync("chafa", [
    "--size=60",        // width only, auto height
    "--colors=256",
    "--symbols=block",  // use block characters
    imagePath
  ], { 
    encoding: "utf-8",
    stdio: ["ignore", "inherit", "inherit"]  // pass stdout/stderr directly to terminal
  })
  
  if (result.status !== 0) {
    console.log(`[Image: ${imagePath}]`)
  }
}

// MCP servers are already configured in OpenCode globally (see: opencode mcp list)
// We don't pass any here - we use the global config
const DEFAULT_MCP_SERVERS: any[] = []

async function main() {
  const args = process.argv.slice(2)
  
  // Parse options
  let showImages = true
  const filteredArgs: string[] = []
  
  for (const arg of args) {
    if (arg === "--no-images") {
      showImages = false
    } else if (!arg.startsWith("--")) {
      filteredArgs.push(arg)
    }
  }
  
  // Create client
  const client = new ACPClient({
    cwd: process.cwd(),
    mcpServers: DEFAULT_MCP_SERVERS,
  })
  
  // Set up event handlers
  client.on("connected", (info) => {
    console.log(`Connected to OpenCode ${info?.version || ""}`)
  })
  
  client.on("error", (err) => {
    console.error("[Error]", err)
  })
  
  // Track response for image path detection
  let responseBuffer = ""
  
  client.on("chunk", (text) => {
    process.stdout.write(text)
    responseBuffer += text
  })
  
  // Activity logging - human readable tool status
  client.on("activity", ({ type, message, tool }) => {
    if (type === "tool_start") {
      console.log(`\n> ${message}`)
    }
  })
  
  // Image handling (for CLI just note it was received)
  client.on("image", ({ mimeType, alt }) => {
    console.log(`\n[Image received: ${alt || mimeType}]`)
  })
  
  client.on("agent-set", (agent) => {
    console.log(`Agent: ${agent} (permission-enforced security)`)
  })
  
  try {
    await client.connect()
    await client.createSession()
    
    // Helper to find actual file (handles model hallucinating slightly wrong paths)
    const findImageFile = (mentionedPath: string): string | null => {
      // Try exact path first
      if (existsSync(mentionedPath)) return mentionedPath
      
      // Try variations (model sometimes adds/removes underscores)
      const cacheDir = "/tmp/doclibrary_cache"
      const basename = mentionedPath.split("/").pop() || ""
      
      // Try without extra underscore before page number: page_100 -> page100
      const withoutUnderscore = basename.replace(/_page_(\d+)/, "_page$1")
      const path1 = `${cacheDir}/${withoutUnderscore}`
      if (existsSync(path1)) return path1
      
      // Try with underscore: page100 -> page_100
      const withUnderscore = basename.replace(/_page(\d+)/, "_page_$1")
      const path2 = `${cacheDir}/${withUnderscore}`
      if (existsSync(path2)) return path2
      
      return null
    }
    
    // Helper to display images from response
    const processImages = () => {
      if (!showImages) return
      
      // Find image file paths in the response
      const patterns = [
        /Image file: ([^\n]+\.png)/gi,
        /`(\/tmp\/doclibrary_cache\/[^`]+\.png)`/gi,
        /(\/tmp\/doclibrary_cache\/\S+\.png)/gi,
      ]
      
      const displayedPaths = new Set<string>()
      
      for (const pattern of patterns) {
        const matches = responseBuffer.matchAll(pattern)
        for (const match of matches) {
          const mentionedPath = match[1].trim()
          const actualPath = findImageFile(mentionedPath)
          
          if (actualPath && !displayedPaths.has(actualPath)) {
            displayedPaths.add(actualPath)
            console.log() // newline before image
            displayImage(actualPath)
          }
        }
      }
      responseBuffer = "" // clear buffer
    }
    
    // Single prompt mode
    if (filteredArgs.length > 0) {
      const prompt = filteredArgs.join(" ")
      console.log(`\n> ${prompt}\n`)
      await client.prompt(prompt)
      processImages()
      console.log("\n")
      await client.disconnect()
      return
    }
    
    // Interactive mode
    console.log("\nEntering interactive mode. Type 'exit' or Ctrl+C to quit.\n")
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    
    const promptUser = () => {
      rl.question("> ", async (input) => {
        const trimmed = input.trim()
        
        if (trimmed === "exit" || trimmed === "quit") {
          console.log("Goodbye!")
          await client.disconnect()
          rl.close()
          process.exit(0)
        }
        
        if (trimmed === "") {
          promptUser()
          return
        }
        
        console.log()
        await client.prompt(trimmed)
        processImages()
        console.log("\n")
        promptUser()
      })
    }
    
    promptUser()
    
  } catch (err) {
    console.error("Error:", err)
    await client.disconnect()
    process.exit(1)
  }
}

main()
