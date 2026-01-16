# Architecture

This document describes the architecture of opencode-chat-bridge.

## Overview

opencode-chat-bridge is an OpenCode plugin that bridges AI coding sessions to chat protocols. It follows a modular architecture that separates protocol handling from core bridge logic.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         OpenCode Server                              │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                   opencode-chat-bridge plugin                   │ │
│  │                                                                  │ │
│  │  ┌──────────────────────────────────────────────────────────┐  │ │
│  │  │                      index.ts                             │  │ │
│  │  │  - Plugin entry point                                     │  │ │
│  │  │  - Loads configuration                                    │  │ │
│  │  │  - Initializes bridge and protocols                       │  │ │
│  │  │  - Registers OpenCode event handlers                      │  │ │
│  │  └──────────────────────────────────────────────────────────┘  │ │
│  │                              │                                   │ │
│  │                              ▼                                   │ │
│  │  ┌──────────────────────────────────────────────────────────┐  │ │
│  │  │                      bridge.ts                            │  │ │
│  │  │  - Core message handling logic                            │  │ │
│  │  │  - Coordinates protocols and OpenCode SDK                 │  │ │
│  │  │  - Parses mode commands                                   │  │ │
│  │  │  - Formats and sends responses                            │  │ │
│  │  └──────────────────────────────────────────────────────────┘  │ │
│  │                              │                                   │ │
│  │              ┌───────────────┼───────────────┐                  │ │
│  │              ▼               ▼               ▼                  │ │
│  │  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐      │ │
│  │  │ session-mgr.ts │ │   Matrix       │ │   Discord      │      │ │
│  │  │                │ │   Protocol     │ │   Protocol     │      │ │
│  │  │ - Room→Session │ │   (impl)       │ │   (planned)    │      │ │
│  │  │   mapping      │ │                │ │                │      │ │
│  │  │ - Persistence  │ └────────────────┘ └────────────────┘      │ │
│  │  └────────────────┘                                             │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    OpenCode SDK (ctx.client)                    │ │
│  │  - session.create/prompt/abort                                  │ │
│  │  - event.subscribe (SSE stream)                                 │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

### Plugin Entry (`index.ts`)

The main export that OpenCode loads. Responsibilities:
- Load and validate configuration
- Initialize SessionManager
- Create Bridge instance
- Register protocol adapters
- Start the bridge
- Handle OpenCode lifecycle events (dispose, etc.)

### Bridge (`bridge.ts`)

Core logic coordinating protocols and OpenCode. Responsibilities:
- Register and manage protocol adapters
- Route incoming messages to OpenCode sessions
- Parse mode commands (`!s`, `!d`, etc.)
- Format and split long responses
- Handle typing indicators
- Error handling and recovery

### Session Manager (`session-manager.ts`)

Maps chat rooms to OpenCode sessions. Responsibilities:
- Bidirectional room↔session mapping
- Session persistence (JSON file)
- Stale session cleanup
- Activity tracking

### Protocol Adapters (`protocols/`)

Each chat protocol has its own adapter implementing `ChatProtocol`:

```typescript
interface ChatProtocol {
  name: string
  connected: boolean
  
  connect(): Promise<void>
  disconnect(): Promise<void>
  
  onMessage(handler: (msg: ChatMessage) => void): void
  sendMessage(roomId: string, content: string, options?: SendOptions): Promise<string>
  sendTyping(roomId: string, typing: boolean): Promise<void>
  
  getJoinedRooms(): Promise<string[]>
  getRoomName?(roomId: string): Promise<string | undefined>
}
```

## Data Flow

### Incoming Message Flow

```
Chat User                Protocol Adapter              Bridge                  OpenCode
    │                          │                         │                        │
    │ sends message            │                         │                        │
    │─────────────────────────>│                         │                        │
    │                          │ onMessage callback      │                        │
    │                          │────────────────────────>│                        │
    │                          │                         │ get/create session     │
    │                          │                         │───────────────────────>│
    │                          │                         │                        │
    │                          │<─ sendTyping(true) ─────│                        │
    │                          │                         │                        │
    │                          │                         │ session.prompt()       │
    │                          │                         │───────────────────────>│
    │                          │                         │                        │
    │                          │                         │<── response ───────────│
    │                          │                         │                        │
    │                          │<─ sendTyping(false) ────│                        │
    │                          │                         │                        │
    │                          │<─ sendMessage() ────────│                        │
    │<─────────────────────────│                         │                        │
    │                          │                         │                        │
```

### Session Lifecycle

```
1. User sends first message to bot
2. Bridge checks SessionManager for existing session
3. If no session exists:
   a. Bridge calls OpenCode client.session.create()
   b. SessionManager stores roomId → sessionId mapping
   c. Mapping is persisted to disk
4. Bridge sends prompt to session
5. Response is sent back to chat
6. SessionManager updates lastActivity timestamp
7. Stale sessions (default: 7 days) are cleaned up
```

## Configuration Loading

Configuration is loaded from multiple sources (in order):
1. `./chat-bridge.json` (project root)
2. `./.opencode/chat-bridge.json`
3. `~/.config/opencode/chat-bridge.json` (global)
4. `opencode.json` → `chatBridge` section

Environment variables are resolved using `{env:VAR_NAME}` syntax.

## Protocol Adapter Requirements

Each protocol adapter must:

1. **Implement ChatProtocol interface** - All methods in `protocols/base.ts`
2. **Handle connection lifecycle** - Connect, reconnect, graceful disconnect
3. **Filter relevant messages** - Only pass messages directed at the bot
4. **Strip triggers** - Remove @mentions and command prefixes from content
5. **Format outgoing messages** - Convert markdown to protocol-specific format
6. **Handle protocol limits** - Message length, rate limits, etc.

## Adding a New Protocol

1. Create directory: `src/protocols/<name>/`
2. Create types: `types.ts` with config interface
3. Create client: `client.ts` implementing ChatProtocol
4. Export from `protocols/index.ts`
5. Update `index.ts` to initialize protocol if enabled
6. Add configuration schema
7. Document in `docs/`

## Security Model

The bridge inherits OpenCode's permission system. For chat use cases, recommended settings:

```json
{
  "permission": {
    "*": "deny",
    "webfetch": "allow",
    "read": "deny",
    "edit": "deny",
    "bash": "deny"
  }
}
```

This allows web browsing and search while preventing file system access.

## Future Considerations

### Streaming Responses

OpenCode provides SSE events for streaming. Implementation plan:
1. Subscribe to `event.subscribe()` on bridge start
2. Track active room→session for streaming
3. On `message.part.updated`, send partial content to chat
4. Handle `session.idle` to finalize response

### Multi-Instance Support

For high-availability:
1. Use shared session store (Redis, PostgreSQL)
2. Coordinate typing indicators
3. Handle message deduplication

### Rate Limiting

Per-user/room rate limiting:
1. Token bucket per user
2. Configurable limits
3. Graceful degradation messages
