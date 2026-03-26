/**
 * Integration tests for the Web Connector
 *
 * Tests HTTP endpoints, WebSocket protocol, CORS, and origin enforcement.
 * Does NOT test ACP/OpenCode integration (that requires a running OpenCode).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"

// ---------------------------------------------------------------------------
// Helpers -- start/stop a real web connector on a random port
// ---------------------------------------------------------------------------

let serverProc: ReturnType<typeof Bun.spawn> | null = null
let PORT: number
let BASE: string

/** Pick a free port, start the connector, wait until ready. */
async function startServer(env: Record<string, string> = {}) {
  PORT = 10000 + Math.floor(Math.random() * 50000)
  BASE = `http://127.0.0.1:${PORT}`

  serverProc = Bun.spawn(["bun", "connectors/web.ts"], {
    env: {
      ...process.env,
      WEB_PORT: String(PORT),
      WEB_HOST: "127.0.0.1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  // Wait for server to be ready (poll health endpoint)
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.ok) return
    } catch {}
    await Bun.sleep(200)
  }
  throw new Error("Server did not start in time")
}

function stopServer() {
  if (serverProc) {
    serverProc.kill()
    serverProc = null
  }
}

// =============================================================================
// HTTP endpoint tests
// =============================================================================

describe("web connector HTTP", () => {
  beforeAll(() => startServer())
  afterAll(stopServer)

  test("GET /health returns status JSON", async () => {
    const res = await fetch(`${BASE}/health`)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.connector).toBe("web")
    expect(typeof body.sessions).toBe("number")
    expect(typeof body.clients).toBe("number")
  })

  test("GET / returns same as /health", async () => {
    const res = await fetch(`${BASE}/`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
  })

  test("GET /widget.js returns JavaScript", async () => {
    const res = await fetch(`${BASE}/widget.js`)
    expect(res.status).toBe(200)

    const ct = res.headers.get("content-type") || ""
    expect(ct).toContain("javascript")

    const js = await res.text()
    expect(js).toContain("OpenCode Chat Bridge")
    expect(js).toContain("__ocWidgetLoaded")
  })

  test("GET /widget.js includes CORS header", async () => {
    const res = await fetch(`${BASE}/widget.js`, {
      headers: { Origin: "https://example.com" },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy()
  })

  test("GET /test returns widget test page", async () => {
    const res = await fetch(`${BASE}/test`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("Widget")
    expect(html).toContain("/widget.js")
  })

  test("GET /test-embedded returns embedded test page", async () => {
    const res = await fetch(`${BASE}/test-embedded`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("Embedded")
    expect(html).toContain("/widget.js")
  })

  test("GET /unknown returns 404", async () => {
    const res = await fetch(`${BASE}/unknown`)
    expect(res.status).toBe(404)
  })

  test("OPTIONS preflight returns 204", async () => {
    const res = await fetch(`${BASE}/widget.js`, { method: "OPTIONS" })
    expect(res.status).toBe(204)
  })
})

// =============================================================================
// WebSocket tests
// =============================================================================

describe("web connector WebSocket", () => {
  beforeAll(() => startServer())
  afterAll(stopServer)

  test("connects and receives connected message", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?clientId=test-1`)

    const msg = await new Promise<any>((resolve, reject) => {
      ws.onmessage = (ev) => resolve(JSON.parse(ev.data))
      ws.onerror = reject
      setTimeout(() => reject(new Error("timeout")), 5000)
    })

    expect(msg.type).toBe("connected")
    expect(msg.clientId).toBe("test-1")
    expect(msg.hasSession).toBe(false)
    ws.close()
  })

  test("assigns clientId if not provided", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)

    const msg = await new Promise<any>((resolve, reject) => {
      ws.onmessage = (ev) => resolve(JSON.parse(ev.data))
      ws.onerror = reject
      setTimeout(() => reject(new Error("timeout")), 5000)
    })

    expect(msg.type).toBe("connected")
    expect(msg.clientId).toBeTruthy()
    expect(msg.clientId.length).toBeGreaterThan(0)
    expect(msg.hasSession).toBe(false)
    ws.close()
  })

  test("rejects invalid JSON", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?clientId=test-bad`)

    // Wait for connected
    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve()
    })

    // Send garbage
    ws.send("not json")

    const msg = await new Promise<any>((resolve) => {
      ws.onmessage = (ev) => resolve(JSON.parse(ev.data))
    })

    expect(msg.type).toBe("error")
    expect(msg.message).toContain("Invalid JSON")
    ws.close()
  })

  test("handles /help command", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?clientId=test-help`)

    // Wait for connected
    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve()
    })

    ws.send(JSON.stringify({ type: "message", text: "/help" }))

    const msg = await new Promise<any>((resolve) => {
      ws.onmessage = (ev) => resolve(JSON.parse(ev.data))
    })

    expect(msg.type).toBe("response")
    expect(msg.text).toContain("OpenCode Chat Bridge")
    expect(msg.text).toContain("/help")
    ws.close()
  })

  test("handles /status with no session", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?clientId=test-status`)

    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve()
    })

    ws.send(JSON.stringify({ type: "message", text: "/status" }))

    const msg = await new Promise<any>((resolve) => {
      ws.onmessage = (ev) => resolve(JSON.parse(ev.data))
    })

    expect(msg.type).toBe("response")
    expect(msg.text).toContain("No active session")
    ws.close()
  })

  test("ignores empty messages", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?clientId=test-empty`)

    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve()
    })

    // Send empty
    ws.send(JSON.stringify({ type: "message", text: "   " }))

    // Send a command after to prove the connection still works
    ws.send(JSON.stringify({ type: "message", text: "/help" }))

    const msg = await new Promise<any>((resolve) => {
      ws.onmessage = (ev) => resolve(JSON.parse(ev.data))
    })

    // Should get help response (empty was skipped)
    expect(msg.type).toBe("response")
    expect(msg.text).toContain("OpenCode Chat Bridge")
    ws.close()
  })

  test("ignores unknown message types", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?clientId=test-unk`)

    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve()
    })

    // Unknown type should be silently ignored
    ws.send(JSON.stringify({ type: "ping" }))

    // Followed by a valid command
    ws.send(JSON.stringify({ type: "message", text: "/help" }))

    const msg = await new Promise<any>((resolve) => {
      ws.onmessage = (ev) => resolve(JSON.parse(ev.data))
    })

    expect(msg.type).toBe("response")
    ws.close()
  })

  test("rate limits rapid messages", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?clientId=test-rate`)

    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve()
    })

    // First command should work
    ws.send(JSON.stringify({ type: "message", text: "/help" }))
    const msg1 = await new Promise<any>((resolve) => {
      ws.onmessage = (ev) => resolve(JSON.parse(ev.data))
    })
    expect(msg1.type).toBe("response")

    // Immediate second should be rate limited
    ws.send(JSON.stringify({ type: "message", text: "/help" }))
    const msg2 = await new Promise<any>((resolve) => {
      ws.onmessage = (ev) => resolve(JSON.parse(ev.data))
    })
    expect(msg2.type).toBe("error")
    expect(msg2.message).toContain("wait")

    ws.close()
  })
})

// =============================================================================
// Origin enforcement tests
// =============================================================================

describe("web connector origin enforcement", () => {
  beforeAll(() =>
    startServer({ WEB_ALLOWED_ORIGINS: "https://allowed.com,https://also-ok.com" }),
  )
  afterAll(stopServer)

  test("allows WebSocket from permitted origin", async () => {
    // Bun's WebSocket client doesn't send Origin, so we test via HTTP upgrade
    // with fetch (which won't actually upgrade but lets us check the status)
    const res = await fetch(`${BASE}/ws?clientId=origin-ok`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        Origin: "https://allowed.com",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    })
    // Successful upgrade returns 101 or Bun may handle it differently
    // The key test: it should NOT be 403
    expect(res.status).not.toBe(403)
  })

  test("rejects WebSocket from forbidden origin", async () => {
    const res = await fetch(`${BASE}/ws?clientId=origin-bad`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        Origin: "https://evil.com",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    })
    expect(res.status).toBe(403)
  })

  test("CORS headers reflect allowed origin", async () => {
    const res = await fetch(`${BASE}/widget.js`, {
      headers: { Origin: "https://allowed.com" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.com")
  })

  test("CORS headers reject unknown origin", async () => {
    const res = await fetch(`${BASE}/widget.js`, {
      headers: { Origin: "https://evil.com" },
    })
    const acao = res.headers.get("access-control-allow-origin")
    expect(acao).not.toBe("https://evil.com")
  })
})
