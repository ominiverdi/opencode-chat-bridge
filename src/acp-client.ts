/**
 * ACP Client - Handles communication with OpenCode via ACP protocol
 */

import { spawn, type ChildProcess } from "child_process"
import { EventEmitter } from "events"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

// Find the opencode executable
function findOpencode(): string {
  // Check environment variable first
  if (process.env.OPENCODE_PATH && existsSync(process.env.OPENCODE_PATH)) {
    return process.env.OPENCODE_PATH
  }
  
  // Common installation paths
  const paths = [
    join(homedir(), ".opencode", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ]
  
  for (const p of paths) {
    if (existsSync(p)) {
      return p
    }
  }
  
  // Fall back to PATH lookup
  return "opencode"
}

export interface ACPClientOptions {
  cwd?: string
  mcpServers?: MCPServer[]
}

export interface MCPServer {
  name: string
  command: string
  args: string[]
  env?: string[]
}

export interface SessionUpdate {
  type: "text" | "thought" | "tool_call" | "tool_result" | "error" | "done"
  content?: string
  toolName?: string
  toolArgs?: any
  toolResult?: string
}

// Activity events for UX logging (tool calls, searches, etc.)
export interface ActivityEvent {
  type: "tool_start" | "tool_end" | "searching" | "fetching" | "processing"
  tool?: string
  message: string
  details?: any
}

// Image content from tool results
export interface ImageContent {
  type: "image"
  mimeType: string
  data: string  // base64 encoded
  alt?: string
}

export class ACPClient extends EventEmitter {
  private acp: ChildProcess | null = null
  private requestId = 0
  private pending = new Map<number, (msg: any) => void>()
  private buffer = ""
  private sessionId: string | null = null
  private cwd: string
  private mcpServers: MCPServer[]
  
  constructor(options: ACPClientOptions = {}) {
    super()
    this.cwd = options.cwd || process.cwd()
    this.mcpServers = options.mcpServers || []
  }
  
  async connect(): Promise<void> {
    const opencodePath = findOpencode()
    console.log(`[ACP] Using opencode at: ${opencodePath}`)
    
    this.acp = spawn(opencodePath, ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
    })
    
    this.acp.stdout!.on("data", (data) => this.handleData(data))
    this.acp.stderr!.on("data", (data) => {
      const text = data.toString()
      if (!text.includes("Error handling")) {
        this.emit("error", text)
      }
    })
    this.acp.on("close", (code) => this.emit("close", code))
    
    // Wait for process to start
    await this.sleep(300)
    
    // Initialize
    const initResult = await this.send("initialize", { protocolVersion: 1 })
    if (initResult.error) {
      throw new Error(`Initialize failed: ${JSON.stringify(initResult.error)}`)
    }
    
    this.emit("connected", initResult.result?.agentInfo)
  }
  
  async createSession(): Promise<string> {
    const result = await this.send("session/new", {
      cwd: this.cwd,
      mcpServers: this.mcpServers,
    })
    
    if (result.error || !result.result?.sessionId) {
      throw new Error(`Session creation failed: ${JSON.stringify(result.error)}`)
    }
    
    this.sessionId = result.result.sessionId
    
    // Emit the current mode (agent) from session result
    const currentMode = result.result?.modes?.currentModeId
    if (currentMode) {
      this.emit("agent-set", currentMode)
    }
    
    // Wait for MCP servers to initialize
    await this.sleep(1000)
    
    return this.sessionId!
  }
  
  async prompt(text: string, options: { agent?: string } = {}): Promise<string> {
    if (!this.sessionId) {
      await this.createSession()
    }
    
    let responseText = ""
    let currentThought = ""
    
    // Set up update listener for this prompt
    const updateHandler = (update: SessionUpdate) => {
      if (update.type === "text") {
        responseText += update.content || ""
      } else if (update.type === "thought") {
        currentThought += update.content || ""
      }
    }
    
    this.on("update", updateHandler)
    
    const params: any = {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    }
    
    if (options.agent) {
      params.agent = options.agent
    }
    
    await this.send("session/prompt", params)
    
    this.off("update", updateHandler)
    
    return responseText
  }
  
  async disconnect(): Promise<void> {
    if (this.acp) {
      this.acp.kill()
      this.acp = null
    }
    this.sessionId = null
  }
  
  private send(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve) => {
      const id = ++this.requestId
      const msg = { jsonrpc: "2.0", id, method, params }
      this.pending.set(id, resolve)
      this.acp!.stdin!.write(JSON.stringify(msg) + "\n")
    })
  }
  
  private handleData(data: Buffer): void {
    this.buffer += data.toString()
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() || ""
    
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        this.handleMessage(msg)
      } catch {}
    }
  }
  
  private handleMessage(msg: any): void {
    // Debug: log ALL incoming messages
    if (msg.method) {
      console.error(`[ACP MSG] method=${msg.method} id=${msg.id || 'none'} full:`, JSON.stringify(msg).slice(0, 500))
    }
    
    // Handle notifications
    if (msg.method === "session/update") {
      this.handleSessionUpdate(msg.params)
      return
    }
    
    // Handle permission requests - auto-reject with message
    if (msg.method === "session/request_permission") {
      this.handlePermissionRequest(msg)
      return
    }
    
    // Handle responses
    if (msg.id && this.pending.has(msg.id)) {
      const resolve = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      resolve(msg)
      return
    }
    
    // Log unhandled messages with an id (requests we don't handle)
    if (msg.id && msg.method) {
      console.error(`[ACP UNHANDLED REQUEST] method=${msg.method} id=${msg.id}`, JSON.stringify(msg.params || {}).slice(0, 200))
    }
  }
  
  private handlePermissionRequest(msg: any): void {
    const params = msg.params
    const toolCall = params.toolCall || {}
    const title = toolCall.title || "unknown"
    const locations = toolCall.locations || []
    const path = locations[0]?.path || "unknown path"
    
    console.error(`[ACP] Permission requested: ${title} (${path}) - auto-rejecting`)
    
    // Emit an event so the connector can show the user what happened
    this.emit("permission_rejected", {
      permission: title,
      path: path,
      message: `Permission denied: ${title} (${path})`,
    })
    
    // Send rejection response
    const response = {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        outcome: {
          outcome: "selected",
          optionId: "reject",
        },
      },
    }
    this.acp!.stdin!.write(JSON.stringify(response) + "\n")
  }
  
  private handleSessionUpdate(params: any): void {
    const update = params.update
    
    // Debug: log all session updates
    console.error(`[ACP DEBUG] sessionUpdate: ${update.sessionUpdate}`, JSON.stringify(update).slice(0, 200))
    
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text") {
          this.emit("update", { type: "text", content: update.content.text })
          this.emit("chunk", update.content.text)
        }
        // Handle image content in messages
        if (update.content?.type === "image") {
          this.emit("image", {
            type: "image",
            mimeType: update.content.mimeType || "image/png",
            data: update.content.data,
            alt: update.content.alt,
          })
        }
        break
        
      case "agent_thought_chunk":
        if (update.content?.type === "text") {
          this.emit("update", { type: "thought", content: update.content.text })
        }
        break
        
      case "tool_call":
        // Initial tool call - just note it's pending
        // Args come in tool_call_update with status: "in_progress"
        const toolNameInit = update.title || update.name || "unknown"
        this.emit("tool", { name: toolNameInit, status: "pending", args: {} })
        break
        
      case "tool_call_update":
        const toolNameUpdate = update.title || update.name || "unknown"
        let toolArgsUpdate = update.rawInput || {}
        
        // Parse if string
        if (typeof toolArgsUpdate === "string") {
          try {
            toolArgsUpdate = JSON.parse(toolArgsUpdate)
          } catch {
            toolArgsUpdate = { raw: toolArgsUpdate }
          }
        }
        
        // Emit activity when we get the args (in_progress status)
        if (update.status === "in_progress") {
          this.emit("update", {
            type: "tool_call",
            toolName: toolNameUpdate,
            toolArgs: toolArgsUpdate,
          })
          this.emit("tool", { name: toolNameUpdate, status: update.status, args: toolArgsUpdate })
          
          // Emit human-readable activity event with actual tool name for transparency
          const activity = this.formatToolActivity(toolNameUpdate, toolArgsUpdate, "start")
          this.emit("activity", {
            type: "tool_start",
            tool: activity.toolName,
            message: `${activity.description} [${activity.toolName}]`,
            description: activity.description,
            details: toolArgsUpdate,
          })
          
          // Stream partial output if available (e.g., bash stdout during execution)
          if (update.rawOutput?.output) {
            this.emit("update", {
              type: "tool_output_delta",
              toolName: toolNameUpdate,
              toolCallId: update.toolCallId,
              partialOutput: update.rawOutput.output,
            })
            this.emit("tool_output_delta", {
              tool: toolNameUpdate,
              toolCallId: update.toolCallId,
              output: update.rawOutput.output,
            })
          }
        }
        
        // Handle completed status with result
        if (update.status === "completed") {
          // Get result from content or rawOutput
          let result = ""
          if (update.content && Array.isArray(update.content)) {
            for (const item of update.content) {
              if (item.content?.type === "text") {
                result += item.content.text
              }
              if (item.content?.type === "image") {
                this.emit("image", {
                  type: "image",
                  mimeType: item.content.mimeType || "image/png",
                  data: item.content.data,
                  alt: item.content.alt,
                })
              }
            }
          } else if (update.rawOutput?.output) {
            result = update.rawOutput.output
          }
          
          if (result) {
            this.emit("update", {
              type: "tool_result",
              toolName: toolNameUpdate,
              toolCallId: update.toolCallId,
              toolResult: result,
            })
            
            // Check if result contains image data
            this.parseToolResultForImages(result)
          }
          
          // Emit activity end
          this.emit("activity", {
            type: "tool_end",
            tool: toolNameUpdate,
            message: "Done",
          })
        }
        
        // Handle failed status (blocked or error)
        if (update.status === "failed") {
          let errorMsg = "Tool execution failed"
          if (update.content && Array.isArray(update.content)) {
            for (const item of update.content) {
              if (item.content?.type === "text") {
                errorMsg = item.content.text
              }
            }
          } else if (update.rawOutput?.error) {
            errorMsg = update.rawOutput.error
          }
          
          this.emit("update", {
            type: "tool_result",
            toolName: toolNameUpdate,
            toolCallId: update.toolCallId,
            toolResult: `[Error] ${errorMsg}`,
          })
          
          // Emit activity end with error
          this.emit("activity", {
            type: "tool_end",
            tool: toolNameUpdate,
            message: "Failed",
          })
        }
        break
    }
  }
  
  // Format tool calls into human-readable activity messages
  // Returns object with both human message and actual tool name for transparency
  private formatToolActivity(tool: string, args: any, phase: "start" | "end"): { description: string; toolName: string } {
    if (phase === "end") return { description: "Done", toolName: tool }
    
    let description = ""
    
    // Document library tools
    if (tool.includes("doclibrary_find_document")) {
      description = `Searching for document: ${args.query || "..."}`
    } else if (tool.includes("doclibrary_search_documents")) {
      description = `Searching documents: ${args.query || "..."}`
    } else if (tool.includes("doclibrary_get_page_image") || tool.includes("doclibrary_get_page_path")) {
      description = `Getting page ${args.page_number || args.pageNumber || "?"} from ${args.document_slug || "document"}`
    } else if (tool.includes("doclibrary_get_element_image") || tool.includes("doclibrary_get_element_path")) {
      description = `Getting ${args.element_label || "element"} from ${args.document_slug || "document"}`
    } else if (tool.includes("doclibrary_list_documents")) {
      description = "Listing available documents"
    } else if (tool.includes("doclibrary_get_document_info")) {
      description = `Getting info for ${args.document_slug || "document"}`
    } else if (tool.includes("doclibrary_list_elements")) {
      description = `Listing elements in ${args.document_slug || "document"}`
    } else if (tool.includes("doclibrary_search_visual_elements")) {
      description = `Searching visual elements: ${args.query || "..."}`
    }
    // Web search tools
    else if (tool.includes("web-search") || tool.includes("web_search")) {
      description = `Searching the web: ${args.query || "..."}`
    } else if (tool.includes("get-single-web-page") || tool.includes("webfetch")) {
      description = `Fetching: ${args.url || "..."}`
    }
    // Time tools
    else if (tool.includes("time_get_current_time")) {
      description = `Getting time in ${args.timezone || "timezone"}`
    } else if (tool.includes("time_convert_time")) {
      description = `Converting time`
    }
    // Google search
    else if (tool.includes("google_search")) {
      description = `Searching Google: ${args.query || "..."}`
    }
    // Default - just use the tool name
    else {
      description = `Executing`
    }
    
    return { description, toolName: tool }
  }
  
  // Parse tool results for embedded images (base64)
  private parseToolResultForImages(result: string): void {
    try {
      const parsed = JSON.parse(result)
      
      // Handle array of content items (common MCP pattern)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.type === "image" && item.data) {
            this.emit("image", {
              type: "image",
              mimeType: item.mimeType || "image/png",
              data: item.data,
              alt: item.alt,
            })
          }
        }
      }
      // Handle direct image object
      else if (parsed.type === "image" && parsed.data) {
        this.emit("image", {
          type: "image",
          mimeType: parsed.mimeType || "image/png",
          data: parsed.data,
          alt: parsed.alt,
        })
      }
      // Handle nested content array
      else if (parsed.content && Array.isArray(parsed.content)) {
        for (const item of parsed.content) {
          if (item.type === "image" && item.data) {
            this.emit("image", {
              type: "image",
              mimeType: item.mimeType || "image/png",
              data: item.data,
              alt: item.alt,
            })
          }
        }
      }
    } catch {
      // Not JSON or no images, ignore
    }
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
