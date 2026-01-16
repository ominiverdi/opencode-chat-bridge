# opencode-chat-bridge

An OpenCode plugin that bridges AI coding sessions to chat protocols like Matrix, Discord, and IRC.

> **Status:** Early development. Matrix protocol is the initial focus.

## Why?

[OpenCode](https://opencode.ai) is a powerful open-source AI coding agent with thousands of contributors, continuous evolution, and a rich plugin ecosystem. Instead of building another AI chat bot from scratch, this plugin lets you leverage OpenCode's capabilities through your preferred chat platform.

**Benefits:**
- Use OpenCode's battle-tested agent logic and tool system
- Access the full MCP (Model Context Protocol) ecosystem  
- Benefit from community updates, bug fixes, and new features
- Focus on your domain-specific tools (knowledge bases, libraries, etc.)
- Let the community help maintain protocol adapters

## Features

- **Matrix Protocol** - Full Matrix support with optional E2EE
- **Session Management** - Persistent room-to-session mapping
- **Mode Commands** - Switch between agents (`!s`, `!d`, `!a`, etc.)
- **Streaming Responses** - Real-time response streaming (planned)
- **Multi-Protocol** - Architecture supports Discord, IRC, and more (planned)

## Installation

```bash
# Install the plugin
bun add opencode-chat-bridge

# Or with npm
npm install opencode-chat-bridge
```

## Quick Start

1. **Add to your OpenCode config:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-chat-bridge"]
}
```

2. **Create chat bridge config:**

```bash
cp node_modules/opencode-chat-bridge/config.example.json chat-bridge.json
```

3. **Configure Matrix credentials:**

```json
{
  "matrix": {
    "enabled": true,
    "homeserver": "https://matrix.org",
    "userId": "@your-bot:matrix.org",
    "accessToken": "{env:MATRIX_ACCESS_TOKEN}"
  }
}
```

4. **Set environment variables:**

```bash
export MATRIX_ACCESS_TOKEN="your_access_token_here"
```

5. **Run OpenCode:**

```bash
opencode
```

The chat bridge starts automatically and connects to Matrix.

## Configuration

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for full configuration reference.

### Matrix Setup

See [docs/MATRIX_SETUP.md](docs/MATRIX_SETUP.md) for detailed Matrix setup instructions.

### Mode Commands

By default, the following mode commands are available:

| Command | Agent | Description |
|---------|-------|-------------|
| `!s` | serious | Default mode with web tools |
| `!d` | sarcastic | Witty, humorous responses |
| `!a` | agent | Multi-turn research mode |
| `!p` | plan | Planning without file edits |

Example: `@bot: !a research async Python patterns`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenCode Server                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              opencode-chat-bridge plugin             │   │
│  │  ┌─────────────────┐    ┌─────────────────────────┐ │   │
│  │  │     Bridge      │◄───│   Session Manager       │ │   │
│  │  │  (core logic)   │    │ (room → session map)    │ │   │
│  │  └────────┬────────┘    └─────────────────────────┘ │   │
│  │           │                                          │   │
│  │  ┌────────▼────────────────────────────────────────┐ │   │
│  │  │              Protocol Adapters                   │ │   │
│  │  │  ┌────────┐  ┌─────────┐  ┌─────┐  ┌────────┐  │ │   │
│  │  │  │ Matrix │  │ Discord │  │ IRC │  │ (more) │  │ │   │
│  │  │  └────────┘  └─────────┘  └─────┘  └────────┘  │ │   │
│  │  └─────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Adding Custom Tools

The bridge works seamlessly with MCP servers. Add your custom tools to OpenCode and they're available through chat:

```json
{
  "mcp": {
    "my-knowledge-base": {
      "type": "local",
      "command": ["python", "-m", "my_kb.mcp"]
    }
  }
}
```

## Security Considerations

When running an AI agent accessible via public chat:

1. **Lock down permissions** - Disable file editing and bash by default
2. **Use dedicated accounts** - Don't use personal chat accounts
3. **Monitor usage** - Watch for abuse patterns
4. **Rate limit** - Implement rate limiting per user/room

See [docs/SECURITY.md](docs/SECURITY.md) for recommended configurations.

## Contributing

Contributions are welcome! See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

### Adding a New Protocol

1. Create adapter in `src/protocols/<name>/`
2. Implement `ChatProtocol` interface
3. Add configuration types
4. Update plugin to register the protocol
5. Add documentation

## Related Projects

- [OpenCode](https://opencode.ai) - The open source AI coding agent
- [Kimaki](https://github.com/remorses/kimaki) - Discord bot for OpenCode (inspiration)
- [Portal](https://github.com/hosenur/portal) - Mobile web UI for OpenCode

## License

MIT
