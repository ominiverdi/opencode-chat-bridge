# Architecture

This document describes the architecture of opencode-chat-bridge and the lessons learned during development.

## Overview

opencode-chat-bridge is a **standalone service** that bridges Matrix chat to OpenCode AI sessions. It runs as a separate process from OpenCode and communicates via HTTP API.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Matrix Homeserver                                │
│                        (matrix.org, etc.)                                │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 │ Matrix Protocol (HTTP)
                                 │
┌────────────────────────────────▼────────────────────────────────────────┐
│                        standalone.ts                                     │
│                        (bun process)                                     │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    Matrix Client (matrix-js-sdk)                  │   │
│  │  - Connects as bot user                                           │   │
│  │  - Listens for messages with trigger patterns                     │   │
│  │  - Sends responses back to rooms                                  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                 │                                        │
│                                 │ Message Handler                        │
│                                 │                                        │
│  ┌──────────────────────────────▼───────────────────────────────────┐   │
│  │                    Bridge Logic                                   │   │
│  │  - Strip trigger patterns                                         │   │
│  │  - Parse mode commands (!s, !d, etc.)                            │   │
│  │  - Manage room → session mapping                                  │   │
│  │  - Format and split long responses                                │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                 │                                        │
│                                 │ OpenCode SDK                           │
│                                 │                                        │
└─────────────────────────────────┼────────────────────────────────────────┘
                                  │
                                  │ HTTP API (localhost:4096)
                                  │
┌─────────────────────────────────▼────────────────────────────────────────┐
│                         OpenCode Server                                   │
│                        (opencode serve)                                   │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │                    Session Management                              │   │
│  │  - Create sessions                                                 │   │
│  │  - Send prompts                                                    │   │
│  │  - Manage conversation history                                     │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                  │                                        │
│  ┌───────────────────────────────▼───────────────────────────────────┐   │
│  │                    LLM Providers                                   │   │
│  │  - Anthropic (Claude)                                              │   │
│  │  - OpenAI                                                          │   │
│  │  - Local models                                                    │   │
│  └───────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Message Flow

```
1. User sends message in Matrix room
   "@bot: !s what is QGIS?"

2. Matrix client receives message event
   - Check: is it directed at us? (trigger pattern match)
   - Check: is it from someone else? (not our own message)

3. Bridge processes message
   - Strip trigger: "!s what is QGIS?"
   - Parse mode: agent="serious", content="what is QGIS?"

4. Session management
   - Look up existing session for this room
   - If none, create new session via OpenCode API

5. Send to OpenCode
   - POST /session/{id}/prompt
   - Body: { parts: [{type: "text", text: "what is QGIS?"}], agent: "serious" }

6. OpenCode processes
   - Routes to configured LLM
   - May use tools (web search, etc.)
   - Returns response parts

7. Bridge formats response
   - Extract text from response parts
   - Split if too long for Matrix (>4000 chars)

8. Send to Matrix
   - matrix.sendMessage(roomId, response)
```

### Session Lifecycle

```
Room first message:
  └── Check session map (none found)
      └── Call opencode.session.create({ title: "Matrix: room-name" })
          └── Store roomId → sessionId mapping
              └── Send prompt to new session

Subsequent messages:
  └── Check session map (found: sessionId)
      └── Send prompt to existing session
          └── Session maintains conversation context
```

## Why Standalone?

### Original Plan: OpenCode Plugin

We initially designed this as an OpenCode plugin that would:
- Load inside the OpenCode process
- Use `ctx.client` to interact with sessions
- Run the Matrix client as a background task

```typescript
// Original plugin approach (did not work)
export const ChatBridgePlugin: Plugin = async (ctx: PluginInput): Promise<Hooks> => {
  const bridge = new Bridge(ctx.client, config)
  await bridge.start()
  return { /* hooks */ }
}
```

### What Went Wrong

**IMPORTANT: Do NOT use the plugin line in opencode.json:**
```json
// BROKEN - causes error below
"plugin": ["./src/index.ts"]
```

1. **Class constructor error**
   ```
   TypeError: Cannot call a class constructor without |new|
       at Bridge (/path/to/src/bridge.ts:57:14)
   ```
   OpenCode's plugin loader cannot instantiate our Bridge class. This is an ESM/bundling incompatibility that has not been resolved.

2. **Plugin design mismatch**
   
   OpenCode plugins are designed for:
   - Exposing **tools** (like `generate_image`)
   - Adding **hooks** to respond to OpenCode events
   
   Our use case needs:
   - Running a **persistent background service** (Matrix client)
   - **Creating sessions** from external triggers
   
3. **No direct session API in plugin context**
   
   The `ctx.client` provided to plugins is optimized for tool execution, not for managing sessions from external events.

### Why Standalone Works Better

1. **Separation of concerns** - Bridge is a separate process with its own lifecycle
2. **Simpler debugging** - Can restart bridge without affecting OpenCode
3. **Clear API boundary** - Uses documented HTTP API, not internal SDK
4. **Easier deployment** - Two processes, clear responsibilities

## Configuration Requirements

### opencode.json is Mandatory

The OpenCode server requires `opencode.json` in the working directory. Without it:

```
TypeError: undefined is not an object (evaluating 'agent.name')
    at createUserMessage (src/session/prompt.ts:831:14)
```

The bot will respond with "No response generated" for all prompts.

### Minimum Required Config

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-20250514",
  "agent": {
    "serious": {
      "mode": "primary",
      "description": "Helpful assistant"
    }
  }
}
```

### Default vs Custom Personality

| Config | Bot Behavior |
|--------|--------------|
| No custom `prompt` | "I'm Claude Code, Anthropic's official CLI coding agent..." |
| With custom `prompt` | Uses your specified personality (e.g., "document library assistant") |

Both configurations have access to MCP tools. The custom prompt only changes how the bot introduces itself and frames responses.

## OpenCode SDK Usage

The bridge uses `@opencode-ai/sdk` to communicate with the server:

```typescript
import { createOpencodeClient } from '@opencode-ai/sdk'

const opencode = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' })

// List existing sessions
const sessions = await opencode.session.list()

// Create a new session
const session = await opencode.session.create({
  body: { title: 'Matrix: room-name' }
})

// Send a prompt
const result = await opencode.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: 'text', text: 'Hello!' }],
    agent: 'serious'  // optional
  }
})

// Response format
result.data.parts  // Array of { type: 'text', text: '...' }
```

## Key Components

### standalone.ts

The main bridge script containing:
- Configuration constants
- Matrix client initialization
- Message filtering and parsing
- Session management (in-memory map)
- OpenCode API calls
- Response formatting

### opencode.json

OpenCode server configuration:
- Model selection
- Permission settings
- Agent definitions

### chat-bridge.json (Optional)

Extended Matrix configuration for the plugin approach. Not used by standalone, but kept for reference.

## Plugin Code (src/)

The `src/` directory contains the original plugin implementation:
- `index.ts` - Plugin entry point
- `bridge.ts` - Bridge class with full protocol abstraction
- `session-manager.ts` - Persistent session mapping
- `protocols/` - Protocol adapters (Matrix, future Discord/IRC)

This code is **not used** by the standalone approach but is preserved for:
- Future plugin attempts if OpenCode's loader improves
- Reference for the protocol abstraction pattern
- Potential extraction into a shared library

## Future Improvements

### Session Persistence

Currently sessions are stored in memory. To survive restarts:
```typescript
// Save to file
const sessions = new Map<string, string>()
// On create: fs.writeFile('sessions.json', JSON.stringify([...sessions]))
// On start: sessions = new Map(JSON.parse(fs.readFile('sessions.json')))
```

### Streaming Responses

OpenCode supports SSE for streaming. Implementation:
1. Use `opencode.session.promptAsync()` for non-blocking
2. Subscribe to `opencode.global.event()` for updates
3. Send partial responses to Matrix as they arrive

### Rate Limiting

Add per-user rate limiting:
```typescript
const userLimits = new Map<string, { count: number, resetAt: number }>()

function checkRateLimit(userId: string): boolean {
  const limit = userLimits.get(userId)
  const now = Date.now()
  if (!limit || now > limit.resetAt) {
    userLimits.set(userId, { count: 1, resetAt: now + 60000 })
    return true
  }
  if (limit.count >= 10) return false
  limit.count++
  return true
}
```

### E2EE Support

For encrypted Matrix rooms, would need:
- `matrix-nio` style crypto store
- Device verification handling
- Key sharing

This is complex - consider using unencrypted rooms for simplicity.
