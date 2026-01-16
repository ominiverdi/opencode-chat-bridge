# opencode-chat-bridge Agent Guide

## Project Overview

OpenCode plugin that bridges AI coding sessions to chat protocols (Matrix, Discord, IRC).

**Status:** Early development - Matrix protocol is the initial focus.

**Test Room:** #osgeo-bot:matrix.org

## Build/Test Commands

- Install dependencies: `bun install`
- Run in dev mode: `bun run dev`
- Type check: `bun run typecheck`
- Build: `bun run build`
- Run tests: `bun test`

## Architecture

```
src/
├── index.ts              # Plugin entry point, config loading
├── bridge.ts             # Core logic: routes messages to OpenCode
├── session-manager.ts    # Maps chat rooms → OpenCode sessions
├── protocols/
│   ├── base.ts           # ChatProtocol interface (all adapters implement this)
│   └── matrix/
│       ├── client.ts     # Matrix protocol implementation
│       └── types.ts      # Matrix-specific types
└── utils/
    ├── config.ts         # Config loading, env var resolution
    └── logger.ts         # Logging utilities
```

## Key Interfaces

### ChatProtocol (protocols/base.ts)
All protocol adapters must implement:
- `connect()` / `disconnect()` - Lifecycle
- `onMessage(handler)` - Register message handler
- `sendMessage(roomId, content)` - Send to chat
- `sendTyping(roomId, typing)` - Typing indicators

### Bridge (bridge.ts)
- Registers protocol adapters
- Routes incoming messages to OpenCode sessions
- Parses mode commands (!s, !d, !a, etc.)
- Handles response formatting and splitting

### SessionManager (session-manager.ts)
- Bidirectional room↔session mapping
- JSON persistence
- Stale session cleanup

## Configuration

Config is loaded from (in order):
1. `./chat-bridge.json`
2. `./.opencode/chat-bridge.json`
3. `~/.config/opencode/chat-bridge.json`
4. `opencode.json` → `chatBridge` section

Environment variables: `{env:VAR_NAME}` or `{env:VAR_NAME:default}`

## Code Style

- **Language:** TypeScript with strict mode
- **Runtime:** Bun
- **Imports:** Use `type` imports for types only
- **Naming:** camelCase functions, PascalCase classes/interfaces
- **Errors:** Log with context, fail fast for unrecoverable

## Dependencies

- `matrix-js-sdk` - Matrix protocol client
- `@opencode-ai/plugin` - OpenCode plugin types (peer dependency)

## Adding a New Protocol

1. Create `src/protocols/<name>/` directory
2. Create `types.ts` with config interface extending `ProtocolConfig`
3. Create `client.ts` implementing `ChatProtocol`
4. Update `index.ts` to register protocol if enabled
5. Add docs in `docs/<NAME>_SETUP.md`
6. Update `config.example.json`

## Current TODOs

- [ ] Test Matrix connection with real homeserver
- [ ] Implement E2EE support (optional, complex)
- [ ] Add streaming response support via OpenCode events
- [ ] Implement rate limiting per user/room
- [ ] Add Discord protocol adapter
- [ ] Add IRC protocol adapter
- [ ] Publish to npm

## Related Projects

- [Kimaki](https://github.com/remorses/kimaki) - Discord bot for OpenCode (reference)
- [Portal](https://github.com/hosenur/portal) - Mobile web UI for OpenCode
- [matrix-llmagent](https://github.com/ominiverdi/osgeo-llmagent) - Original Matrix bot (being replaced)

## Testing Notes

- Use `opencode serve --port 4097` for isolated dev server
- Test room: #osgeo-bot:matrix.org
- For E2EE testing, use a separate device ID to avoid conflicts
