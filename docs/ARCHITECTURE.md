# Architecture

This document describes the architecture of opencode-chat-bridge.

## Overview

opencode-chat-bridge uses the **ACP (Agent Client Protocol)** to communicate with OpenCode. This provides a clean, JSON-RPC based interface for creating sessions and sending prompts.

```
                                    ACP Protocol
                                   (JSON-RPC/stdio)
                                         |
+------------------+              +------v-------+              +----------------+
|                  |   prompt     |              |   LLM API   |                |
|   CLI / Chat     |------------->|   OpenCode   |------------>|  LLM Provider  |
|   Connector      |<-------------|   (acp)      |<------------|  (Anthropic)   |
|                  |   stream     |              |   response  |                |
+------------------+              +--------------+              +----------------+
         |                               |
         |                               |
    User Input                    MCP Tool Calls
                                  (time, web-search, etc.)
```

## Components

### 1. ACP Client (`src/acp-client.ts`)

The core client that communicates with OpenCode via ACP:

```typescript
const client = new ACPClient({ cwd: process.cwd() })
await client.connect()      // Spawns `opencode acp` process
await client.createSession() // Creates a new session
await client.prompt("...")   // Sends prompt, streams response
```

**Key features:**
- EventEmitter-based for streaming responses
- Automatic session management
- Tool call notifications

**Events:**
- `chunk` - Response text token
- `tool` - Tool execution status
- `agent-set` - Current agent/mode
- `error` - Error messages
- `close` - Process closed

### 2. CLI (`src/cli.ts`)

Interactive command-line interface:

```bash
bun src/cli.ts              # Interactive mode
bun src/cli.ts "prompt"     # Single prompt
```

**Features:**
- Interactive REPL mode
- Streams responses in real-time

### 3. Security Configuration (`opencode.json`)

Defines the secure `chat-bridge` agent with permission restrictions:

```json
{
  "default_agent": "chat-bridge",
  "agent": {
    "chat-bridge": {
      "permission": {
        "read": "deny",
        "bash": "deny",
        "time_*": "allow"
      }
    }
  }
}
```

## ACP Protocol Flow

### Initialization

```
Client                          OpenCode (acp)
   |                                  |
   |  {"method": "initialize"}        |
   |--------------------------------->|
   |  {"result": {agentInfo: ...}}    |
   |<---------------------------------|
```

### Session Creation

```
Client                          OpenCode (acp)
   |                                  |
   |  {"method": "session/new"}       |
   |--------------------------------->|
   |  {"result": {sessionId, modes}}  |
   |<---------------------------------|
```

The `modes` field includes `currentModeId` which reflects the `default_agent` setting.

### Prompting

```
Client                          OpenCode (acp)
   |                                  |
   |  {"method": "session/prompt"}    |
   |--------------------------------->|
   |                                  |
   |  {"method": "session/update",    |
   |   "params": {update: ...}}       |  (notification)
   |<---------------------------------|
   |  ... more updates ...            |
   |                                  |
   |  {"result": {stopReason}}        |
   |<---------------------------------|
```

### Session Updates

| Update Type | Description |
|-------------|-------------|
| `agent_message_chunk` | Response text token |
| `agent_thought_chunk` | Internal reasoning |
| `tool_call` | Tool execution started |
| `tool_call_update` | Tool result |

## Permission Enforcement

Permissions are enforced at the OpenCode level, not via prompts:

```
User Prompt: "Read /etc/passwd"
                |
                v
+---------------------------+
|   LLM decides to call     |
|   read tool               |
+---------------------------+
                |
                v
+---------------------------+
|   OpenCode checks         |
|   agent.permission.read   |
|   = "deny"                |
+---------------------------+
                |
                v
+---------------------------+
|   Tool call BLOCKED       |
|   Error returned to LLM   |
+---------------------------+
                |
                v
+---------------------------+
|   LLM explains it cannot  |
|   read files              |
+---------------------------+
```

This is resistant to prompt injection because:
1. The permission check happens BEFORE the tool executes
2. The config is not accessible to the LLM
3. Even if the LLM is tricked, OpenCode enforces the rules

## Building Chat Connectors

To build a chat platform connector (Matrix, Slack, Mattermost, WhatsApp, Discord, IRC, etc.):

### 1. Create a connector that uses ACPClient

```typescript
import { ACPClient } from "./src"

class MatrixConnector {
  private client: ACPClient
  
  constructor() {
    this.client = new ACPClient({ cwd: process.cwd() })
    this.client.on("chunk", (text) => this.sendToRoom(text))
    this.client.on("tool", ({ name }) => this.sendStatus(name))
  }
  
  async start() {
    await this.client.connect()
    await this.client.createSession()
  }
  
  async handleMessage(roomId: string, text: string) {
    // ACPClient handles the session internally
    await this.client.prompt(text)
  }
}
```

### 2. Handle streaming responses

The `chunk` event provides real-time response tokens:

```typescript
let buffer = ""
client.on("chunk", (text) => {
  buffer += text
  // Send to chat when sentence complete or buffer full
  if (buffer.endsWith(".") || buffer.length > 500) {
    sendToChat(buffer)
    buffer = ""
  }
})
```

### 3. Handle tool calls

Show users what tools are being used:

```typescript
client.on("tool", ({ name, status }) => {
  if (status === "pending") {
    sendToChat(`[Searching with ${name}...]`)
  }
})
```

### 4. Handle images and documents from tool results

**Important:** Images and documents from MCP tools come in tool results, NOT in response text chunks. You must listen to `update` events:

```typescript
let toolResultsBuffer = ""

// Capture tool results
client.on("update", (update) => {
  if (update.type === "tool_result" && update.toolResult) {
    toolResultsBuffer += update.toolResult
  }
})

// After prompt completes, check for image markers
const imageRegex = /\[DOCLIBRARY_IMAGE\]([^\[]+)\[\/DOCLIBRARY_IMAGE\]/gi
const matches = toolResultsBuffer.matchAll(imageRegex)
for (const match of matches) {
  const imagePath = match[1].trim()
  if (fs.existsSync(imagePath)) {
    sendImageToChat(imagePath)
  }
}
```

The `chunk` event only receives `agent_message_chunk` updates (the LLM's text response). Tool results with image/document paths are sent via `tool_call_update` events with status `completed`.

Documents use the same pattern with `[DOCLIBRARY_DOC]` markers:

```typescript
// After prompt completes, also check for document markers
const docRegex = /\[DOCLIBRARY_DOC\]([^\[]+)\[\/DOCLIBRARY_DOC\]/gi
const docMatches = toolResultsBuffer.matchAll(docRegex)
for (const match of docMatches) {
  const docPath = match[1].trim()
  if (fs.existsSync(docPath)) {
    sendDocumentToChat(docPath)  // platform-specific: PDF, CSV, etc.
  }
}
```

## Session Management

Each connector creates one ACPClient per conversation context. The session key
varies by platform:

| Platform | Session Key | Isolation |
|----------|-------------|-----------|
| Slack | `channel:threadTs` | Per-thread |
| Matrix | `roomId` | Per-room |
| Discord | `channelId` | Per-channel |
| Mattermost | `channelId:rootId` | Per-thread |
| WhatsApp | `chatId` | Per-chat |

`BaseConnector.getOrCreateSession()` handles creating the ACPClient, connecting,
and session setup. `SessionManager` tracks all active sessions.

### Runtime Session Expiry

`BaseConnector` provides an optional background sweep that expires inactive
sessions after `SESSION_RETENTION_MINS` minutes. Sessions with active in-flight
queries are protected from eviction. On expiry, both the in-memory session and
on-disk cache directory are cleaned up.

### Event Deduplication

`EventDeduplicator` prevents duplicate event processing. All platforms can
deliver duplicate events (Slack retries, Matrix syncs, Discord re-deliveries).
Events are tracked by ID with a 5-minute eviction window.

### Active Query Guard

Concurrent queries on the same session are rejected with a user-visible message.
The guard also protects busy sessions from being evicted by the expiry sweep.

## MCP Tool Integration

MCP servers are configured globally in OpenCode. The `chat-bridge` agent can use:

| Server | Tools |
|--------|-------|
| `time` | `time_get_current_time`, `time_convert_time` |
| `weather` | `weather_get_weather`, `weather_get_forecast`, etc. |
| `web-search` | `web-search_full-web-search`, etc. |

These are examples. Any MCP server can be used - just configure permissions in `opencode.json`.

Dangerous servers like `chrome-devtools` are blocked by the permission config.

## Future Improvements

### 1. Session Persistence

Save session IDs to survive restarts (currently in-memory sessions are lost).

### 2. Thread Isolation for Other Platforms

Slack uses per-thread sessions. Discord and Mattermost also have thread
concepts that could benefit from similar isolation.

### 3. Opt-in Base Features for Other Connectors

Event deduplication, active query guard, and session expiry are available in
`BaseConnector` but currently only Slack opts in. Matrix, Discord, Mattermost,
and WhatsApp connectors need small changes to call these methods.
