/**
 * OpenCode Chat Bridge - Web Widget
 *
 * Self-contained embeddable chat interface. No external dependencies.
 *
 * Modes:
 *   "widget"   (default) - floating bubble + popup panel
 *   "embedded" - fills a container element, no bubble
 *
 * Configuration (set BEFORE loading this script):
 *
 *   window.OpenCodeWidget = {
 *     mode: "widget",            // "widget" | "embedded"
 *     container: "#chat",        // CSS selector (embedded mode)
 *     title: "OpenCode",
 *     placeholder: "Type a message...",
 *     welcome: "Hello! How can I help?",
 *     position: "right",         // bubble side: "right" | "left"
 *     theme: {
 *       primary: "#2563eb",
 *       header: "#1e293b",
 *     }
 *   };
 */
;(function () {
  "use strict"

  // Prevent double-init
  if (window.__ocWidgetLoaded) return
  window.__ocWidgetLoaded = true

  // ==========================================================================
  // Configuration
  // ==========================================================================

  var UC = window.OpenCodeWidget || {}

  // Auto-detect server from script src
  var scriptEl = document.currentScript || document.querySelector('script[src*="widget.js"]')
  var scriptUrl = scriptEl ? new URL(scriptEl.src) : null
  var SERVER = scriptUrl ? scriptUrl.origin : window.location.origin
  var WS_PROTO = scriptUrl
    ? scriptUrl.protocol === "https:" ? "wss:" : "ws:"
    : window.location.protocol === "https:" ? "wss:" : "ws:"
  var WS_URL = WS_PROTO + "//" + (scriptUrl ? scriptUrl.host : window.location.host) + "/ws"

  var MODE = UC.mode || "widget" // "widget" | "embedded"
  var CONTAINER_SEL = UC.container || null

  var CFG = {
    title: UC.title || "OpenCode",
    placeholder: UC.placeholder || "Type a message...",
    welcome: UC.welcome || null,
    position: UC.position || "right",
    primary: (UC.theme && UC.theme.primary) || "#2563eb",
    header: (UC.theme && UC.theme.header) || "#1e293b",
    userBg: (UC.theme && UC.theme.userBg) || "#2563eb",
    userText: (UC.theme && UC.theme.userText) || "#ffffff",
    botBg: (UC.theme && UC.theme.botBg) || "#f1f5f9",
    botText: (UC.theme && UC.theme.botText) || "#1e293b",
  }

  // ==========================================================================
  // State
  // ==========================================================================

  var STORE_KEY = "oc-widget"
  var ws = null
  var state = loadState()
  var clientId = state.clientId || uid()
  var messages = state.messages || []
  var isOpen = MODE === "embedded" // embedded starts open
  var isProcessing = false
  var reconnAttempts = 0
  var reconnTimer = null
  var curBotEl = null // DOM element currently receiving streamed chunks
  var pendingMessage = null // queued when sending while disconnected

  // DOM refs
  var root, bubble, panel, msgsEl, inputEl, sendBtn, statusEl, thinkingEl

  // ==========================================================================
  // Helpers
  // ==========================================================================

  function uid() {
    return "oc_" + Math.random().toString(36).slice(2) + Date.now().toString(36)
  }

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") }
    catch (e) { return {} }
  }

  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        clientId: clientId,
        messages: messages.slice(-50),
      }))
    } catch (e) { /* quota etc */ }
  }

  function esc(t) {
    var d = document.createElement("div")
    d.textContent = t
    return d.innerHTML
  }

  function scrollDown() {
    if (msgsEl) requestAnimationFrame(function () { msgsEl.scrollTop = msgsEl.scrollHeight })
  }

  // ==========================================================================
  // Styles
  // ==========================================================================

  function injectCSS() {
    var s = document.createElement("style")
    s.textContent = [
      // --- Reset scoped to widget ---
      ".oc-root,.oc-root *{box-sizing:border-box;margin:0;padding:0;}",
      ".oc-root{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;color:#1e293b;}",

      // --- Widget mode container (fixed) ---
      ".oc-root--widget{position:fixed;bottom:20px;" + CFG.position + ":20px;z-index:99999;}",

      // --- Embedded mode container ---
      ".oc-root--embedded{position:relative;width:100%;height:100%;min-height:300px;}",

      // --- Bubble ---
      ".oc-bubble{width:56px;height:56px;border-radius:50%;background:" + CFG.primary + ";color:#fff;border:none;cursor:pointer;" +
        "display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.2);" +
        "transition:transform .2s,box-shadow .2s;position:relative;}",
      ".oc-bubble:hover{transform:scale(1.06);box-shadow:0 6px 20px rgba(0,0,0,.25);}",
      ".oc-bubble svg{width:24px;height:24px;fill:currentColor;}",
      ".oc-badge{position:absolute;top:-2px;right:-2px;width:12px;height:12px;background:#ef4444;border-radius:50%;border:2px solid #fff;display:none;}",
      ".oc-badge--on{display:block;}",

      // --- Panel (widget mode) ---
      ".oc-panel--widget{position:absolute;bottom:70px;" + CFG.position + ":0;width:380px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 120px);" +
        "background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.15);display:none;flex-direction:column;overflow:hidden;border:1px solid #e2e8f0;}",
      ".oc-panel--widget.oc-open{display:flex;animation:oc-up .25s ease-out;}",

      // --- Panel (embedded mode) ---
      ".oc-panel--embedded{width:100%;height:100%;background:#fff;display:flex;flex-direction:column;overflow:hidden;border-radius:inherit;}",

      "@keyframes oc-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}",

      // --- Header ---
      ".oc-hdr{background:" + CFG.header + ";color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}",
      ".oc-hdr-t{font-weight:600;font-size:15px;}",
      ".oc-hdr-s{font-size:11px;opacity:.7;margin-top:1px;}",
      ".oc-hdr-actions{display:flex;gap:4px;align-items:center;}",
      ".oc-btn-icon{background:none;border:none;color:#fff;cursor:pointer;padding:4px;opacity:.7;transition:opacity .2s;border-radius:4px;}",
      ".oc-btn-icon:hover{opacity:1;background:rgba(255,255,255,.1);}",
      ".oc-btn-icon svg{width:18px;height:18px;fill:currentColor;display:block;}",

      // --- Messages ---
      ".oc-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;}",
      ".oc-msgs::-webkit-scrollbar{width:6px;} .oc-msgs::-webkit-scrollbar-track{background:transparent;} .oc-msgs::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px;}",

      // --- Bubbles ---
      ".oc-msg{max-width:85%;padding:10px 14px;border-radius:12px;word-wrap:break-word;white-space:pre-wrap;font-size:14px;}",
      ".oc-msg--user{align-self:flex-end;background:" + CFG.userBg + ";color:" + CFG.userText + ";border-bottom-right-radius:4px;}",
      ".oc-msg--bot{align-self:flex-start;background:" + CFG.botBg + ";color:" + CFG.botText + ";border-bottom-left-radius:4px;}",

      // --- Activity ---
      ".oc-activity{align-self:flex-start;font-size:12px;color:#6b7280;background:#f3f4f6;padding:6px 10px;border-left:3px solid #9ca3af;border-radius:4px;font-family:monospace;margin:4px 0;}",
      ".oc-tool-out{align-self:stretch;background:#1e293b;color:#e2e8f0;padding:10px 12px;border-radius:8px;font-family:monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;margin:4px 0;}",
      ".oc-tool-details{align-self:stretch;margin:4px 0;}",
      ".oc-tool-details summary{font-size:12px;color:#64748b;cursor:pointer;padding:4px 0;user-select:none;}",
      ".oc-tool-details summary:hover{color:#475569;}",
      ".oc-tool-out--collapsed{margin-top:4px;max-height:300px;}",

      // --- Thinking dots ---
      ".oc-think{align-self:flex-start;padding:10px 14px;display:none;gap:5px;}",
      ".oc-think--on{display:flex;}",
      ".oc-think span{width:8px;height:8px;background:#94a3b8;border-radius:50%;animation:oc-dot 1.4s infinite ease-in-out both;}",
      ".oc-think span:nth-child(1){animation-delay:-.32s;} .oc-think span:nth-child(2){animation-delay:-.16s;}",
      "@keyframes oc-dot{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}",

      // --- Input area ---
      ".oc-inp-area{padding:12px;border-top:1px solid #e2e8f0;display:flex;gap:8px;flex-shrink:0;background:#fff;}",
      ".oc-inp{flex:1;padding:10px 14px;border:1px solid #e2e8f0;border-radius:10px;font-size:14px;font-family:inherit;resize:none;" +
        "outline:none;max-height:100px;min-height:40px;line-height:1.4;transition:border-color .2s;}",
      ".oc-inp:focus{border-color:" + CFG.primary + ";}",
      ".oc-inp::placeholder{color:#94a3b8;}",
      ".oc-send{width:40px;height:40px;border-radius:10px;background:" + CFG.primary + ";color:#fff;border:none;cursor:pointer;" +
        "display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .2s;align-self:flex-end;}",
      ".oc-send:disabled{opacity:.4;cursor:not-allowed;}",
      ".oc-send svg{width:18px;height:18px;fill:currentColor;}",

      // --- Welcome ---
      ".oc-welcome{text-align:center;color:#64748b;padding:20px;font-size:13px;}",

      // --- Images ---
      ".oc-msg img{max-width:100%;border-radius:8px;margin-top:6px;}",

      // --- Mobile ---
      "@media(max-width:480px){" +
        ".oc-panel--widget{position:fixed;bottom:80px;left:12px;right:12px;width:auto;height:calc(100vh - 100px);border-radius:12px;}" +
      "}",
    ].join("\n")
    document.head.appendChild(s)
  }

  // ==========================================================================
  // SVG icons
  // ==========================================================================

  var ICON_CHAT = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>'
  var ICON_DOWN = '<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>'
  var ICON_CLOSE = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
  var ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>'
  var ICON_CLEAR = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'

  // ==========================================================================
  // DOM
  // ==========================================================================

  function build() {
    root = document.createElement("div")
    root.className = "oc-root oc-root--" + MODE

    // --- Panel ---
    panel = document.createElement("div")
    panel.className = MODE === "embedded" ? "oc-panel--embedded" : "oc-panel--widget"
    if (MODE === "embedded") panel.classList.add("oc-open")

    // Header
    var hdr = document.createElement("div")
    hdr.className = "oc-hdr"

    var hdrLeft = document.createElement("div")
    hdrLeft.innerHTML = '<div class="oc-hdr-t">' + esc(CFG.title) + '</div><div class="oc-hdr-s" id="oc-status">Connecting...</div>'
    statusEl = hdrLeft.querySelector("#oc-status")

    var hdrActions = document.createElement("div")
    hdrActions.className = "oc-hdr-actions"

    // Clear button
    var clearBtn = document.createElement("button")
    clearBtn.className = "oc-btn-icon"
    clearBtn.title = "Clear chat"
    clearBtn.innerHTML = ICON_CLEAR
    clearBtn.onclick = clearChat
    hdrActions.appendChild(clearBtn)

    // Close button (widget mode only)
    if (MODE === "widget") {
      var closeBtn = document.createElement("button")
      closeBtn.className = "oc-btn-icon"
      closeBtn.title = "Close"
      closeBtn.innerHTML = ICON_CLOSE
      closeBtn.onclick = togglePanel
      hdrActions.appendChild(closeBtn)
    }

    hdr.appendChild(hdrLeft)
    hdr.appendChild(hdrActions)

    // Messages
    msgsEl = document.createElement("div")
    msgsEl.className = "oc-msgs"

    // Thinking indicator (lives inside messages, always last)
    thinkingEl = document.createElement("div")
    thinkingEl.className = "oc-think"
    thinkingEl.innerHTML = "<span></span><span></span><span></span>"
    msgsEl.appendChild(thinkingEl)

    // Input area
    var inpArea = document.createElement("div")
    inpArea.className = "oc-inp-area"

    inputEl = document.createElement("textarea")
    inputEl.className = "oc-inp"
    inputEl.placeholder = CFG.placeholder
    inputEl.rows = 1
    inputEl.onkeydown = onKey
    inputEl.oninput = autoGrow

    sendBtn = document.createElement("button")
    sendBtn.className = "oc-send"
    sendBtn.innerHTML = ICON_SEND
    sendBtn.onclick = doSend

    inpArea.appendChild(inputEl)
    inpArea.appendChild(sendBtn)

    panel.appendChild(hdr)
    panel.appendChild(msgsEl)
    panel.appendChild(inpArea)

    root.appendChild(panel)

    // --- Bubble (widget mode only) ---
    if (MODE === "widget") {
      bubble = document.createElement("button")
      bubble.className = "oc-bubble"
      bubble.setAttribute("aria-label", "Open chat")
      bubble.innerHTML = ICON_CHAT + '<span class="oc-badge"></span>'
      bubble.onclick = togglePanel
      root.appendChild(bubble)
    }

    // Mount
    if (MODE === "embedded" && CONTAINER_SEL) {
      var target = document.querySelector(CONTAINER_SEL)
      if (target) {
        target.appendChild(root)
      } else {
        console.warn("[OpenCode Widget] Container not found: " + CONTAINER_SEL)
        document.body.appendChild(root)
      }
    } else {
      document.body.appendChild(root)
    }

    renderHistory()
  }

  // ==========================================================================
  // Message rendering
  // ==========================================================================

  function renderHistory() {
    // Clear everything except the thinking indicator
    while (msgsEl.firstChild !== thinkingEl) {
      msgsEl.removeChild(msgsEl.firstChild)
    }

    if (messages.length === 0 && CFG.welcome) {
      var w = document.createElement("div")
      w.className = "oc-welcome"
      w.textContent = CFG.welcome
      msgsEl.insertBefore(w, thinkingEl)
    }

    for (var i = 0; i < messages.length; i++) {
      appendBubble(messages[i].role, messages[i].text)
    }
    scrollDown()
  }

  function appendBubble(role, text) {
    // Remove welcome
    var w = msgsEl.querySelector(".oc-welcome")
    if (w) w.remove()

    var el = document.createElement("div")
    el.className = "oc-msg oc-msg--" + role
    el.textContent = text
    msgsEl.insertBefore(el, thinkingEl)
    return el
  }

  // ==========================================================================
  // UI actions
  // ==========================================================================

  function togglePanel() {
    isOpen = !isOpen
    panel.classList.toggle("oc-open", isOpen)

    if (bubble) {
      bubble.innerHTML = isOpen
        ? ICON_DOWN + '<span class="oc-badge"></span>'
        : ICON_CHAT + '<span class="oc-badge"></span>'
    }

    if (isOpen) {
      hideBadge()
      inputEl.focus()
      scrollDown()
      ensureConnected()
    }
  }

  function showBadge() {
    if (!bubble) return
    var b = bubble.querySelector(".oc-badge")
    if (b) b.classList.add("oc-badge--on")
  }

  function hideBadge() {
    if (!bubble) return
    var b = bubble.querySelector(".oc-badge")
    if (b) b.classList.remove("oc-badge--on")
  }

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  function autoGrow() {
    inputEl.style.height = "auto"
    inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + "px"
  }

  function doSend() {
    var text = inputEl.value.trim()
    if (!text || isProcessing) return

    addMsg("user", text)
    inputEl.value = ""
    inputEl.style.height = "auto"

    showThinking()
    isProcessing = true
    sendBtn.disabled = true

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "message", text: text }))
    } else {
      // Queue message -- it will be sent automatically on reconnect
      pendingMessage = text
      ensureConnected()
    }
  }

  function addMsg(role, text) {
    messages.push({ role: role, text: text, ts: Date.now() })
    appendBubble(role, text)
    scrollDown()
    saveState()
  }

  function clearChat() {
    // Send /clear to server if connected
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "message", text: "/clear" }))
    }
    messages = []
    saveState()
    renderHistory()
  }

  function showThinking() {
    thinkingEl.classList.add("oc-think--on")
    scrollDown()
  }

  function hideThinking() {
    thinkingEl.classList.remove("oc-think--on")
  }

  function showActivity(text) {
    // Create a new activity element each time (persists like other bridges)
    var el = document.createElement("div")
    el.className = "oc-activity"
    el.textContent = "> " + text
    msgsEl.insertBefore(el, thinkingEl)
    scrollDown()
  }

  function clearActivity() {
    // Activities and tool output persist - nothing to clear
  }

  function appendToolOutput(text) {
    // Reuse existing tool-output block or create one
    var el = msgsEl.querySelector(".oc-tool-out:last-of-type")
    if (!el || el.nextElementSibling !== thinkingEl) {
      el = document.createElement("pre")
      el.className = "oc-tool-out"
      msgsEl.insertBefore(el, thinkingEl)
    }
    el.textContent += (el.textContent ? "\n" : "") + text
    scrollDown()
  }

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t
  }

  // ==========================================================================
  // WebSocket
  // ==========================================================================

  function ensureConnected() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return
    connect()
  }

  function connect() {
    var url = WS_URL + "?clientId=" + encodeURIComponent(clientId)
    ws = new WebSocket(url)

    ws.onopen = function () {
      reconnAttempts = 0
      setStatus("Online")
      sendBtn.disabled = isProcessing ? true : false

      // Flush any message queued while disconnected
      if (pendingMessage) {
        ws.send(JSON.stringify({ type: "message", text: pendingMessage }))
        pendingMessage = null
      }
    }

    ws.onmessage = function (ev) {
      try { handleServer(JSON.parse(ev.data)) } catch (e) {}
    }

    ws.onclose = function () {
      setStatus("Disconnected")
      scheduleReconn()
    }

    ws.onerror = function () { /* onclose fires next */ }
  }

  function scheduleReconn() {
    if (reconnTimer) return
    reconnAttempts++
    var delay = Math.min(1000 * Math.pow(2, reconnAttempts - 1), 30000)
    setStatus("Reconnecting in " + Math.round(delay / 1000) + "s...")
    reconnTimer = setTimeout(function () {
      reconnTimer = null
      connect()
    }, delay)
  }

  // ==========================================================================
  // Server message handling
  // ==========================================================================

  function handleServer(d) {
    switch (d.type) {

      case "connected":
        clientId = d.clientId
        // Server has no session for us -- clear stale history
        if (!d.hasSession && messages.length > 0) {
          messages = []
          renderHistory()
        }
        saveState()
        break

      case "chunk":
        hideThinking()
        if (!curBotEl) {
          curBotEl = appendBubble("bot", "")
        }
        curBotEl.textContent += d.text
        scrollDown()
        break

      case "activity":
        showActivity(d.message)
        break

      case "tool_output":
        // Real-time streaming output from tools (e.g. bash)
        hideThinking()
        appendToolOutput(d.text)
        break

      case "tool_result":
        // Completed tool result (e.g. bash final output)
        hideThinking()
        appendToolOutput(d.text)
        break

      case "permission_denied":
        hideThinking()
        showActivity(d.message)
        break

      case "image":
        hideThinking()
        if (!curBotEl) curBotEl = appendBubble("bot", "")
        var img = document.createElement("img")
        img.src = "data:" + (d.mimeType || "image/png") + ";base64," + d.data
        img.alt = d.alt || "Image"
        curBotEl.appendChild(img)
        scrollDown()
        break

      case "file":
        hideThinking()
        if (!curBotEl) curBotEl = appendBubble("bot", "")
        var link = document.createElement("a")
        link.href = "data:" + (d.mimeType || "application/octet-stream") + ";base64," + d.data
        link.download = d.fileName || "file"
        link.textContent = d.fileName || "Download file"
        link.style.cssText = "display:inline-block;padding:8px 12px;background:#e2e8f0;border-radius:8px;color:#1e293b;text-decoration:none;font-size:13px;margin-top:6px;"
        curBotEl.appendChild(link)
        scrollDown()
        break

      case "done":
        hideThinking()
        clearActivity()
        if (curBotEl) {
          // Move bot text bubble to the bottom (after activities) so it's visible
          msgsEl.insertBefore(curBotEl, thinkingEl)
          scrollDown()
          if (curBotEl.textContent) {
            messages.push({ role: "bot", text: curBotEl.textContent, ts: Date.now() })
            saveState()
          }
        }
        curBotEl = null
        isProcessing = false
        sendBtn.disabled = false
        break

      case "response": // non-streamed (commands)
        hideThinking()
        clearActivity()
        addMsg("bot", d.text)
        curBotEl = null
        isProcessing = false
        sendBtn.disabled = false
        break

      case "error":
        hideThinking()
        clearActivity()
        addMsg("bot", d.message || "An error occurred.")
        curBotEl = null
        isProcessing = false
        sendBtn.disabled = false
        break
    }

    // Show badge if panel is closed
    if (!isOpen && (d.type === "done" || d.type === "response")) {
      showBadge()
    }
  }

  // ==========================================================================
  // Init
  // ==========================================================================

  function init() {
    injectCSS()
    build()
    connect()
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init)
  } else {
    init()
  }
})()
