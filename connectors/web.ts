#!/usr/bin/env bun
/**
 * Web Connector for OpenCode Chat Bridge
 *
 * Serves an embeddable chat widget and a WebSocket endpoint.
 * The widget works in two modes:
 *   - "widget"   : floating bubble + popup panel (default)
 *   - "embedded"  : fills a container div, no bubble
 *
 * Usage:
 *   bun connectors/web.ts
 *
 * Embed (widget mode):
 *   <script src="http://your-server:3420/widget.js"></script>
 *
 * Embed (flat / embedded mode):
 *   <div id="chat" style="height:600px"></div>
 *   <script>window.OpenCodeWidget={mode:"embedded",container:"#chat"}</script>
 *   <script src="http://your-server:3420/widget.js"></script>
 *
 * Environment variables:
 *   WEB_PORT            - Server port (default: 3420)
 *   WEB_HOST            - Bind address (default: 0.0.0.0)
 *   WEB_ALLOWED_ORIGINS - Comma-separated origins for CORS (default: *)
 *   WEB_TRIGGER         - Trigger prefix override (default: from config)
 */

import { readFileSync, existsSync } from "fs"
import { networkInterfaces } from "os"
import { join } from "path"
import type { Server, ServerWebSocket } from "bun"
import {
  ACPClient,
  type ActivityEvent,
  getConfig,
  BaseConnector,
  type BaseSession,
  sanitizeServerPaths,
  extractImagePaths,
  removeImageMarkers,
  extractDocPaths,
  removeDocMarkers,
} from "../src"

// =============================================================================
// Configuration
// =============================================================================

const config = getConfig()
const webCfg = config.web || {} as any
const WEB_PORT = parseInt(process.env.WEB_PORT || String(webCfg.port || 3420), 10)
const WEB_HOST = process.env.WEB_HOST || webCfg.host || "0.0.0.0"
const ALLOWED_ORIGINS = process.env.WEB_ALLOWED_ORIGINS
  ? process.env.WEB_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : (webCfg.allowedOrigins || ["*"])
const TRIGGER = process.env.WEB_TRIGGER || config.trigger
const SESSION_RETENTION_DAYS = parseInt(
  process.env.SESSION_RETENTION_DAYS || "7",
  10,
)
const RATE_LIMIT_SECONDS = 2

/**
 * Detect a reachable LAN IP so logs/snippets show something
 * useful instead of localhost.
 */
function getLanIP(): string {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address
    }
  }
  return "127.0.0.1"
}

/** Public base URL shown in logs and example snippets. */
const WEB_PUBLIC_URL =
  process.env.WEB_PUBLIC_URL ||
  webCfg.publicUrl ||
  `http://${WEB_HOST === "0.0.0.0" ? getLanIP() : WEB_HOST}:${WEB_PORT}`

// =============================================================================
// Types
// =============================================================================

interface WebSession extends BaseSession {}

interface WSData {
  clientId: string
}

// =============================================================================
// WebConnector
// =============================================================================

class WebConnector extends BaseConnector<WebSession> {
  private server: Server | null = null
  private wsClients = new Map<string, ServerWebSocket<WSData>>()
  private widgetSource = ""

  constructor() {
    super({
      connector: "web",
      trigger: TRIGGER,
      botName: config.botName || "OpenCode",
      rateLimitSeconds: RATE_LIMIT_SECONDS,
      sessionRetentionDays: SESSION_RETENTION_DAYS,
    })
  }

  // ---------------------------------------------------------------------------
  // BaseConnector abstract implementations
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.logStartup()
    await this.cleanupSessions()

    // Load widget JS source
    const widgetPath = join(import.meta.dir, "web-widget.js")
    if (!existsSync(widgetPath)) {
      console.error(`Error: Widget file not found at ${widgetPath}`)
      process.exit(1)
    }
    this.widgetSource = readFileSync(widgetPath, "utf-8")

    const connector = this
    this.server = Bun.serve<WSData>({
      port: WEB_PORT,
      hostname: WEB_HOST,

      fetch(req, server) {
        return connector.handleHttp(req, server)
      },

      websocket: {
        open(ws) {
          connector.onWsOpen(ws)
        },
        message(ws, msg) {
          connector.onWsMessage(
            ws,
            typeof msg === "string" ? msg : msg.toString(),
          )
        },
        close(ws) {
          connector.onWsClose(ws)
        },
      },
    })

    this.log(`Server running on ${WEB_PUBLIC_URL}`)
    this.log(`Test page:  ${WEB_PUBLIC_URL}/test`)
    this.log(
      `Embed:  <script src="${WEB_PUBLIC_URL}/widget.js"><\/script>`,
    )
    const originsInfo = ALLOWED_ORIGINS.includes("*") ? "any origin" : ALLOWED_ORIGINS.join(", ")
    this.log(`Security:  origins=${originsInfo}`)
    this.startSessionExpiryLoop()
  }

  async stop(): Promise<void> {
    this.log("Stopping...")
    await this.disconnectAllSessions()
    this.wsClients.clear()
    if (this.server) this.server.stop()
    this.log("Stopped.")
  }

  async sendMessage(clientId: string, text: string): Promise<void> {
    this.wsSend(clientId, { type: "response", text })
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  private handleHttp(
    req: Request,
    server: Server,
  ): Response | undefined {
    const url = new URL(req.url)
    const cors = this.corsHeaders(req)

    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors })
    }

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      // -- Origin check --
      const origin = req.headers.get("origin")
      if (
        !ALLOWED_ORIGINS.includes("*") &&
        origin &&
        !ALLOWED_ORIGINS.includes(origin)
      ) {
        this.log(`[WS] Rejected origin: ${origin}`)
        return new Response("Origin not allowed", { status: 403, headers: cors })
      }


      const clientId =
        url.searchParams.get("clientId") || crypto.randomUUID()
      const ok = server.upgrade(req, { data: { clientId } })
      if (ok) return undefined
      return new Response("WebSocket upgrade failed", { status: 400 })
    }

    // Widget JS
    if (url.pathname === "/widget.js") {
      return new Response(this.widgetSource, {

        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
          ...cors,
        },
      })
    }

    // Health
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json(
        {
          status: "ok",
          connector: "web",
          sessions: this.sessionManager.sessions.size,
          clients: this.wsClients.size,
        },
        { headers: cors },
      )
    }

    // Test page
    if (url.pathname === "/test") {
      return new Response(this.testPage("widget"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }
    if (url.pathname === "/test-embedded") {
      return new Response(this.testPage("embedded"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    return new Response("Not found", { status: 404, headers: cors })
  }

  private corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin") || "*"
    const allowed =
      ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)
    return {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket handlers
  // ---------------------------------------------------------------------------

  private onWsOpen(ws: ServerWebSocket<WSData>): void {
    const { clientId } = ws.data
    this.wsClients.set(clientId, ws)
    const hasSession = this.sessionManager.has(clientId)
    this.log(`[WS] Connected: ${clientId.slice(0, 12)}... (${hasSession ? "resumed" : "new"})`)
    this.wsSend(clientId, { type: "connected", clientId, hasSession })
  }

  private async onWsMessage(
    ws: ServerWebSocket<WSData>,
    raw: string,
  ): Promise<void> {
    const { clientId } = ws.data

    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      this.wsSend(clientId, { type: "error", message: "Invalid JSON" })
      return
    }

    if (msg.type !== "message" || typeof msg.text !== "string") return
    const text = msg.text.trim()
    if (!text) return

    // Rate limit
    if (!this.checkRateLimit(clientId)) {
      this.wsSend(clientId, {
        type: "error",
        message: "Please wait a moment before sending again.",
      })
      return
    }

    // Commands
    if (text.startsWith("/")) {
      const session = this.sessionManager.get(clientId)
      const cmds = session?.client.availableCommands || []
      await this.handleCommand(
        clientId,
        text,
        async (resp) => this.wsSend(clientId, { type: "response", text: resp }),
        {
          openCodeCommands: cmds,
          forwardToOpenCode: async (cmd) => this.processQuery(clientId, cmd),
        },
      )
      return
    }

    await this.processQuery(clientId, text)
  }

  private onWsClose(ws: ServerWebSocket<WSData>): void {
    const { clientId } = ws.data
    this.wsClients.delete(clientId)
    this.log(`[WS] Disconnected: ${clientId.slice(0, 12)}...`)
  }

  // ---------------------------------------------------------------------------
  // Query processing
  // ---------------------------------------------------------------------------

  private async processQuery(
    clientId: string,
    query: string,
  ): Promise<void> {
    const t0 = Date.now()

    if (this.isQueryActive(clientId)) {
      this.wsSend(clientId, {
        type: "error",
        message: "Please wait for the current request to finish.",
      })
      return
    }
    this.markQueryActive(clientId)

    const session = await this.getOrCreateSession(
      clientId,
      (client) => ({ ...this.createBaseSession(client) }) as WebSession,
    )

    if (!session) {
      this.wsSend(clientId, {
        type: "error",
        message: "Could not connect to AI service.",
      })
      this.markQueryDone(clientId)
      return
    }

    session.messageCount++
    session.lastActivity = new Date()
    session.inputChars += query.length

    const client = session.client
    const streamTools = config.streamTools || ["bash"]
    let buf = ""
    let toolResultsBuf = ""
    let tools = 0

    const onChunk = (text: string) => {
      buf += text
      this.wsSend(clientId, { type: "chunk", text })
    }

    const onActivity = (a: ActivityEvent) => {
      if (a.type === "tool_start") {
        tools++
        this.wsSend(clientId, { type: "activity", message: a.message })
      }
    }

    const onImage = (img: any) => {
      const size = img.data ? img.data.length : 0
      this.log(`[IMG] Base64 image received: ${img.mimeType || "unknown"} (${size} chars)`)
      this.wsSend(clientId, {
        type: "image",
        data: img.data,
        mimeType: img.mimeType || "image/png",
        alt: img.alt,
      })
    }

    const onUpdate = (update: any) => {
      // Collect tool results for image/doc extraction
      if (update.type === "tool_result" && update.toolResult) {
        toolResultsBuf += JSON.stringify(update.toolResult)

        // Show tool results for configured tools (e.g. bash output)
        const toolName = update.toolName || ""
        const shouldShow = streamTools.some((t: string) => toolName.includes(t))
        if (shouldShow) {
          const maxLen = 2000
          const result = update.toolResult.length > maxLen
            ? update.toolResult.slice(0, maxLen) + "\n... (truncated)"
            : update.toolResult
          const trimmed = result.trim()
          if (trimmed) {
            this.wsSend(clientId, { type: "tool_result", tool: toolName, text: trimmed })
          }
        }
      }

      // Stream partial tool output in real-time (e.g. long bash commands)
      if (update.type === "tool_output_delta" && update.partialOutput) {
        const toolName = update.toolName || ""
        const shouldStream = streamTools.some((t: string) => toolName.includes(t))
        if (shouldStream) {
          const output = update.partialOutput.trim()
          if (output) {
            this.wsSend(clientId, { type: "tool_output", tool: toolName, text: output })
          }
        }
      }
    }

    const onPermission = (event: { permission: string; path: string | null; message: string }) => {
      this.log(`[PERMISSION] Rejected: ${event.permission}${event.path ? ` (${event.path})` : ""}`)
      this.wsSend(clientId, { type: "permission_denied", message: event.message })
    }

    client.on("chunk", onChunk)
    client.on("activity", onActivity)
    client.on("image", onImage)
    client.on("update", onUpdate)
    client.on("permission_rejected", onPermission)

    // Timeout to prevent stuck requests (5 minutes)
    const QUERY_TIMEOUT_MS = 5 * 60 * 1000
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Request timed out")), QUERY_TIMEOUT_MS)
    )

    try {
      await Promise.race([client.prompt(query), timeoutPromise])

      // Scan all text for image/doc file paths
      const allText = buf + "\n" + toolResultsBuf

      // 1. DOCLIBRARY markers (from MCP tools)
      const markerImages = new Set([
        ...extractImagePaths(toolResultsBuf),
        ...extractImagePaths(buf),
      ])

      // 2. Bare file paths ending in image extensions (from bash etc.)
      const pathRegex = /\/[\w.\-\/]+\.(?:png|jpe?g|gif|webp|svg|bmp)/gi
      const pathMatches = allText.match(pathRegex) || []

      // Combine and deduplicate
      const allImages = new Set([...markerImages, ...pathMatches])
      for (const imgPath of allImages) {
        const trimmed = imgPath.trim()
        if (existsSync(trimmed)) {
          this.sendFileAsImage(clientId, trimmed)
        }
      }

      // Documents: DOCLIBRARY markers + bare file paths
      const markerDocs = new Set([
        ...extractDocPaths(toolResultsBuf),
        ...extractDocPaths(buf),
      ])
      const docRegex = /\/[\w.\-\/]+\.(?:pdf|csv|txt|json|xml|html|md|zip|tar)/gi
      const docMatches = allText.match(docRegex) || []
      const allDocs = new Set([...markerDocs, ...docMatches])
      for (const docPath of allDocs) {
        const trimmed = docPath.trim()
        if (existsSync(trimmed)) {
          this.sendFileAsDoc(clientId, trimmed)
        }
      }

      const clean = sanitizeServerPaths(removeDocMarkers(removeImageMarkers(buf)))
      session.outputChars += clean.length
      this.wsSend(clientId, { type: "done" })

      const sec = ((Date.now() - t0) / 1000).toFixed(1)
      const t = tools > 0 ? `, ${tools} tool${tools > 1 ? "s" : ""}` : ""
      this.log(
        `[DONE] ${clientId.slice(0, 8)}... ${sec}s (${clean.length} chars${t})`,
      )
    } catch (err) {
      this.logError(`[FAIL] ${clientId.slice(0, 8)}...:`, err)
      this.wsSend(clientId, {
        type: "error",
        message: "Something went wrong processing your request.",
      })
      this.wsSend(clientId, { type: "done" })
    } finally {
      client.off("chunk", onChunk)
      client.off("activity", onActivity)
      client.off("image", onImage)
      client.off("update", onUpdate)
      client.off("permission_rejected", onPermission)
      this.markQueryDone(clientId)
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Read an image file from disk and send it to the client as base64.
   */
  private sendFileAsImage(clientId: string, filePath: string): void {
    try {
      if (!existsSync(filePath)) {
        this.logError(`[IMG] File not found: ${filePath}`)
        return
      }
      const data = readFileSync(filePath).toString("base64")
      const ext = filePath.split(".").pop()?.toLowerCase() || "png"
      const mimeMap: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
      }
      this.wsSend(clientId, {
        type: "image",
        data,
        mimeType: mimeMap[ext] || "image/png",
        alt: filePath.split("/").pop(),
      })
      this.log(`[IMG] Sent: ${filePath.split("/").pop()}`)
    } catch (err) {
      this.logError(`[IMG] Failed to read ${filePath}:`, err)
    }
  }

  /**
   * Read a document file from disk and send it to the client as a base64 download.
   */
  private sendFileAsDoc(clientId: string, filePath: string): void {
    try {
      if (!existsSync(filePath)) {
        this.logError(`[DOC] File not found: ${filePath}`)
        return
      }
      const data = readFileSync(filePath).toString("base64")
      const ext = filePath.split(".").pop()?.toLowerCase() || "bin"
      const mimeMap: Record<string, string> = {
        pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
        json: "application/json", xml: "application/xml",
        html: "text/html", md: "text/markdown",
        zip: "application/zip", tar: "application/x-tar",
      }
      const fileName = filePath.split("/").pop() || "file"
      this.wsSend(clientId, {
        type: "file",
        data,
        mimeType: mimeMap[ext] || "application/octet-stream",
        fileName,
      })
      this.log(`[DOC] Sent: ${fileName}`)
    } catch (err) {
      this.logError(`[DOC] Failed to read ${filePath}:`, err)
    }
  }

  private wsSend(clientId: string, data: any): void {
    const ws = this.wsClients.get(clientId)
    if (!ws) return
    try {
      ws.send(JSON.stringify(data))
    } catch (err) {
      this.logError(`[WS] send failed (${clientId.slice(0, 8)}):`, err)
    }
  }

  private testPage(mode: "widget" | "embedded"): string {
    // Actual widget loads via relative path (works from any IP).
    // Example snippets use the public URL so users can copy-paste.
    const pub = WEB_PUBLIC_URL

    if (mode === "embedded") {
      return `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenCode Chat - Embedded</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f1f5f9; display: flex; flex-direction: column; height: 100vh; }
    header { padding: 16px 24px; background: white; border-bottom: 1px solid #e2e8f0; }
    header h1 { font-size: 18px; color: #1e293b; }
    header p  { font-size: 13px; color: #64748b; margin-top: 4px; }
    #chat { flex: 1; margin: 24px; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  </style>
</head><body>
  <header>
    <h1>OpenCode Chat - Embedded Mode</h1>
    <p>The chat fills the container below.
       <a href="/test">Switch to widget mode</a></p>
  </header>
  <div id="chat"></div>
  <script>window.OpenCodeWidget = { mode: "embedded", container: "#chat" }<\/script>
  <script src="/widget.js"><\/script>
</body></html>`
    }

    return `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenCode Chat - Widget</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 60px auto; padding: 0 20px; color: #1e293b; }
    h1 { margin-bottom: 8px; }
    p { color: #475569; line-height: 1.6; }
    pre { background: #f1f5f9; padding: 14px 18px; border-radius: 8px; overflow-x: auto; margin: 16px 0; font-size: 14px; }
    a { color: #2563eb; }
  </style>
</head><body>
  <h1>OpenCode Chat Bridge - Web Widget</h1>
  <p>The chat widget is in the bottom-right corner. Click the bubble to open it.</p>
  <p><a href="/test-embedded">Switch to embedded mode</a></p>
  <h2>Widget snippet</h2>
  <pre>\&lt;script src="${pub}/widget.js"\&gt;\&lt;/script\&gt;</pre>
  <h2>Embedded snippet</h2>
  <pre>\&lt;div id="chat" style="height:600px"\&gt;\&lt;/div\&gt;
\&lt;script\&gt;window.OpenCodeWidget={mode:"embedded",container:"#chat"}\&lt;/script\&gt;
\&lt;script src="${pub}/widget.js"\&gt;\&lt;/script\&gt;</pre>
  <script src="/widget.js"><\/script>
</body></html>`
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const connector = new WebConnector()

  const shutdown = async () => {
    await connector.stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  await connector.start()
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
