# opencode-chat-bridge Agent Guide

## Project Overview

Standalone bridge that connects Matrix chat to OpenCode AI coding sessions.

**Status:** Working! Matrix protocol is implemented and tested.

**Test Room:** #osgeo-bot:matrix.org

## Quick Start

```bash
# Terminal 1: Start OpenCode server
opencode serve --port 4096

# Terminal 2: Start the bridge
source .env
bun standalone.ts
```

## Build/Test Commands

- Install dependencies: `bun install`
- Run bridge: `bun standalone.ts`
- Type check: `bun run typecheck`
- Build plugin (unused): `bun run build`

## Architecture

**Standalone approach (working):**
```
standalone.ts          # Main bridge script - USE THIS
opencode.json          # OpenCode configuration (REQUIRED)
.env                   # MATRIX_ACCESS_TOKEN
start.sh               # Startup script
```

**Plugin approach (BROKEN - do not use):**
```
src/
├── index.ts           # Plugin entry point (causes constructor error)
├── bridge.ts          # Bridge class (cannot be instantiated)
├── session-manager.ts # Session mapping
└── protocols/         # Protocol adapters
```

**IMPORTANT:** Do NOT add `"plugin": ["./src/index.ts"]` to opencode.json. It causes:
```
TypeError: Cannot call a class constructor without |new|
```

The plugin approach failed due to ESM/bundling issues with OpenCode's plugin loader.
See docs/ARCHITECTURE.md for details.

## Data Flow

```
Matrix Message (@bot: hello)
       │
       ▼
standalone.ts (bun process)
       │
       ├── Strip trigger pattern
       ├── Parse mode command
       ├── Get/create OpenCode session
       │
       ▼
OpenCode Server (:4096)
       │
       ├── Route to LLM
       ├── Execute tools
       │
       ▼
Response to Matrix
```

## Configuration

### Environment (.env)
```bash
MATRIX_ACCESS_TOKEN="syt_xxx..."
OPENCODE_URL="http://127.0.0.1:4096"  # optional
```

### Bridge Settings (standalone.ts)
```typescript
const MATRIX_USER_ID = '@llm-assitant:matrix.org'
const TRIGGER_PATTERNS = ['@llm-assitant:', '!oc ']
const MODES = { '!s': 'serious', '!d': 'sarcastic', ... }
```

### OpenCode (opencode.json) - REQUIRED

Without this file, prompts fail with "No response generated".

**Default personality** (Claude Code introduces itself and lists available tools):
```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-20250514",
  "permission": {
    "*": "deny",
    "webfetch": "allow",
    "read": "allow",
    "glob": "allow",
    "grep": "allow"
  },
  "agent": {
    "serious": {
      "mode": "primary",
      "description": "Helpful assistant for general questions",
      "model": "anthropic/claude-sonnet-4-20250514",
      "permission": { "*": "deny", "webfetch": "allow" }
    },
    "sarcastic": {
      "mode": "primary",
      "description": "Witty, humorous assistant",
      "model": "anthropic/claude-sonnet-4-20250514",
      "permission": { "*": "deny", "webfetch": "allow" }
    }
  }
}
```

**Custom personality** (add a `prompt` field to customize behavior):
```json
{
  "agent": {
    "serious": {
      "mode": "primary",
      "description": "Document library assistant",
      "prompt": "You are a document library assistant. Use plain text only, no markdown.",
      "permission": { "*": "deny", "mcp": "allow" }
    }
  }
}
```

## Key APIs

### OpenCode SDK
```typescript
const opencode = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' })

// List sessions
await opencode.session.list()

// Create session
await opencode.session.create({ body: { title: 'Matrix: room' } })

// Send prompt
await opencode.session.prompt({
  path: { id: sessionId },
  body: { parts: [{ type: 'text', text: 'Hello' }], agent: 'serious' }
})
```

### Matrix SDK
```typescript
const matrix = sdk.createClient({
  baseUrl: 'https://matrix.org',
  accessToken: MATRIX_ACCESS_TOKEN,
  userId: MATRIX_USER_ID,
})

matrix.on('Room.timeline', async (event, room) => { ... })
await matrix.sendMessage(roomId, { msgtype: 'm.text', body: 'Hello' })
```

## Dependencies

- `matrix-js-sdk` - Matrix protocol client
- `@opencode-ai/sdk` - OpenCode API client

## Code Style

- **Language:** TypeScript
- **Runtime:** Bun
- **Naming:** camelCase functions, PascalCase classes
- **Errors:** Log with context, fail fast

## Lessons Learned

### Plugin Approach Failed
- OpenCode plugins are for tools/hooks, not background services
- Class constructor error when loading Bridge class
- ESM/bundling incompatibility suspected

### Standalone Works Well
- Clear separation of concerns
- Easier debugging
- Uses documented HTTP API
- Simple to deploy

## Current State

**Working:**
- [x] Matrix message reception
- [x] Trigger pattern filtering
- [x] Mode command parsing
- [x] Session creation
- [x] Prompt sending
- [x] Response formatting
- [x] Long message splitting
- [x] MCP tools (doclibrary, time, web-search, chrome-devtools)
- [x] Default personality (Claude Code)
- [x] Custom personality (via prompt field)

**Not Implemented:**
- [ ] Session persistence (sessions lost on restart)
- [ ] Streaming responses
- [ ] E2EE support
- [ ] Rate limiting
- [ ] Discord/IRC protocols

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| "No response generated" | Missing opencode.json | Create opencode.json with model + agent |
| "Cannot call class constructor" | Plugin line in config | Remove `"plugin"` from opencode.json |
| "agent.name undefined" | No agent defined | Add agent section to opencode.json |
| "unavailable tool" error | MCP not permitted | Add `"mcp": "allow"` to agent permissions |
| Tool appears to work but uses workaround | Permission missing | Check actual tool calls in parts files |

For detailed debugging including how to inspect tool calls and server logs, see [docs/DEBUGGING.md](docs/DEBUGGING.md).

## Related Projects

- [OpenCode](https://opencode.ai) - The AI coding agent
- [Kimaki](https://github.com/remorses/kimaki) - Discord bot (reference)
- [matrix-llmagent](https://github.com/ominiverdi/osgeo-llmagent) - Original Matrix bot

## Testing

1. Send message in #osgeo-bot:matrix.org:
   ```
   !oc hello
   ```

2. Watch bridge logs:
   ```bash
   tail -f /tmp/matrix-bridge.log
   ```

3. Check OpenCode sessions:
   ```bash
   curl http://127.0.0.1:4096/session | jq
   ```
