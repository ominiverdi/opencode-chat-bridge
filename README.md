# opencode-chat-bridge

A standalone bridge that connects Matrix chat to [OpenCode](https://opencode.ai) AI coding sessions.

> **Status:** Working! Matrix protocol is implemented and tested.

## Why?

[OpenCode](https://opencode.ai) is a powerful open-source AI coding agent with thousands of contributors, continuous evolution, and a rich plugin ecosystem. Instead of building another AI chat bot from scratch, this bridge lets you leverage OpenCode's capabilities through Matrix chat.

**Benefits:**
- Use OpenCode's battle-tested agent logic and tool system
- Access the full MCP (Model Context Protocol) ecosystem  
- Benefit from community updates, bug fixes, and new features
- Focus on your domain-specific tools (knowledge bases, libraries, etc.)
- Simple standalone architecture - easy to deploy and debug

## Architecture

```
Matrix Room                    standalone.ts                 OpenCode Server
(#your-room)                   (bun process)                 (opencode serve)
     |                              |                              |
     |  @bot: hello                 |                              |
     |----------------------------->|                              |
     |                              |  POST /session (create)      |
     |                              |----------------------------->|
     |                              |  POST /session/:id/prompt    |
     |                              |----------------------------->|
     |                              |                              |
     |                              |<---- response ---------------|
     |<---- "Hello! How can I..."---|                              |
```

The bridge runs as a separate process that:
1. Connects to Matrix as your bot user
2. Listens for messages with trigger patterns
3. Routes them to OpenCode via HTTP API
4. Returns responses to Matrix

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/yourusername/opencode-chat-bridge
cd opencode-chat-bridge
bun install
```

### 2. Configure Matrix credentials

Create `.env`:
```bash
MATRIX_ACCESS_TOKEN="syt_your_access_token_here"
```

Edit `standalone.ts` to set your bot's user ID:
```typescript
const MATRIX_USER_ID = '@your-bot:matrix.org'
```

### 3. Configure OpenCode

**IMPORTANT:** `opencode.json` is required. Without it, the bot responds with "No response generated".

Create/edit `opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-20250514",
  "permission": {
    "*": "deny",
    "webfetch": "allow",
    "read": "allow"
  },
  "agent": {
    "serious": {
      "mode": "primary",
      "description": "Helpful assistant"
    }
  }
}
```

**Note:** Do NOT add a `"plugin"` line - it causes a class constructor error. The plugin approach does not work; use standalone.ts instead.

### 4. Start the services

Terminal 1 - Start OpenCode server:
```bash
opencode serve --port 4096
```

Terminal 2 - Start the bridge:
```bash
source .env
bun standalone.ts
```

### 5. Test it

In your Matrix room, send:
```
!oc what is the capital of France?
```

## Configuration

### Trigger Patterns

The bridge responds to messages containing:
- `@your-bot:matrix.org` (mention)
- `!oc ` (command prefix)

Edit `TRIGGER_PATTERNS` in `standalone.ts` to customize.

### Mode Commands

Switch between OpenCode agents with mode prefixes:

| Command | Agent | Description |
|---------|-------|-------------|
| `!s` | serious | Helpful assistant |
| `!d` | sarcastic | Witty responses |
| `!a` | agent | Multi-turn research |
| `!p` | plan | Planning mode |

Example: `!oc !s explain async/await in Python`

### OpenCode Agents

Define custom agents in `opencode.json`:

```json
{
  "agent": {
    "serious": {
      "mode": "primary",
      "description": "Helpful assistant",
      "model": "anthropic/claude-sonnet-4-20250514"
    },
    "researcher": {
      "mode": "primary", 
      "description": "Deep research mode",
      "model": "anthropic/claude-sonnet-4-20250514"
    }
  }
}
```

## Session Management

The bridge maintains a room-to-session mapping:
- Each Matrix room gets its own OpenCode session
- Sessions persist conversation context
- Currently stored in memory (restarts clear sessions)

## Security Considerations

When running an AI agent accessible via public chat:

1. **Lock down permissions** - Disable file editing and bash
2. **Use dedicated accounts** - Don't use personal Matrix accounts  
3. **Monitor usage** - Watch logs for abuse
4. **Consider rate limiting** - Add per-user limits if needed

See [docs/SECURITY.md](docs/SECURITY.md) for recommended configurations.

## Project Structure

```
opencode-chat-bridge/
  standalone.ts      # Main bridge script (run this)
  opencode.json      # OpenCode configuration (REQUIRED)
  .env               # Environment variables (MATRIX_ACCESS_TOKEN)
  start.sh           # Startup script (starts both server and bridge)
  docs/              # Documentation
    ARCHITECTURE.md  # System design and data flow
    CONFIGURATION.md # All configuration options
    DEBUGGING.md     # How to investigate issues and inspect logs
    MATRIX_SETUP.md  # Matrix account and room setup
    SECURITY.md      # Security recommendations
  src/               # Plugin code (NOT USED - causes errors if enabled)
```

**Important:** The `src/` directory contains an attempted plugin implementation that does not work. Do not reference it in `opencode.json`.

## Why Standalone Instead of Plugin?

We initially attempted to build this as an OpenCode plugin, but encountered issues:

1. **Class constructor error** - OpenCode's plugin loader had issues with our Bridge class
2. **Different use case** - Plugins are designed for tools/hooks, not persistent background services
3. **Simpler debugging** - Standalone is easier to develop and troubleshoot

The standalone approach works well and is the recommended method. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Related Projects

- [OpenCode](https://opencode.ai) - The open source AI coding agent
- [Kimaki](https://github.com/remorses/kimaki) - Discord bot for OpenCode (inspiration)
- [Portal](https://github.com/hosenur/portal) - Mobile web UI for OpenCode

## Contributing

Contributions welcome! Areas of interest:
- Session persistence (survive restarts)
- Discord protocol adapter
- Rate limiting
- E2EE support for encrypted Matrix rooms

## License

MIT
