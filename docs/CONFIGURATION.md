# Configuration Reference

This document describes all configuration options for opencode-chat-bridge.

## Configuration File Locations

The plugin searches for configuration in order:

1. `./chat-bridge.json` - Project-specific
2. `./.opencode/chat-bridge.json` - OpenCode project directory
3. `~/.config/opencode/chat-bridge.json` - Global user config
4. `opencode.json` → `chatBridge` section - Inline in OpenCode config

## Environment Variables

Use `{env:VAR_NAME}` syntax to reference environment variables:

```json
{
  "matrix": {
    "accessToken": "{env:MATRIX_ACCESS_TOKEN}"
  }
}
```

With default value: `{env:VAR_NAME:default_value}`

## Full Configuration Schema

```json
{
  // Matrix protocol configuration
  "matrix": {
    // Enable/disable Matrix protocol
    "enabled": true,
    
    // Matrix homeserver URL
    "homeserver": "https://matrix.org",
    
    // Bot's Matrix user ID
    "userId": "@bot:matrix.org",
    
    // Access token for authentication
    "accessToken": "{env:MATRIX_ACCESS_TOKEN}",
    
    // Device ID for E2EE (recommended to keep consistent)
    "deviceId": "OPENCODE_BRIDGE",
    
    // End-to-end encryption settings
    "encryption": {
      "enabled": false,
      "storePath": "./matrix-store/"
    },
    
    // Auto-join rooms when invited
    "autoJoin": true,
    
    // Sync settings
    "sync": {
      "initialSyncLimit": 10,
      "timeout": 30000
    },
    
    // Patterns that trigger the bot
    "triggerPatterns": [
      "@bot:",
      "!oc "
    ],
    
    // Mode command mappings (override global)
    "modes": {
      "!s": "serious",
      "!d": "sarcastic"
    },
    
    // Rooms to ignore (room IDs)
    "ignoreRooms": [
      "!abc123:matrix.org"
    ],
    
    // Users to ignore (user IDs)
    "ignoreUsers": [
      "@spammer:example.com"
    ]
  },
  
  // Discord protocol configuration (planned)
  "discord": {
    "enabled": false,
    "token": "{env:DISCORD_TOKEN}",
    // ... Discord-specific options
  },
  
  // IRC protocol configuration (planned)
  "irc": {
    "enabled": false,
    "server": "irc.libera.chat",
    "port": 6697,
    "nick": "opencode-bot",
    "channels": ["#your-channel"],
    "useTLS": true
  },
  
  // Path to persist session mappings
  "sessionStorePath": "./.opencode/chat-sessions.json",
  
  // Default OpenCode agent to use
  "defaultAgent": null,
  
  // Global mode command mappings
  "modes": {
    "!s": "serious",
    "!d": "sarcastic",
    "!a": "agent",
    "!p": "plan"
  }
}
```

## Matrix Configuration

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `homeserver` | string | Matrix homeserver URL |
| `userId` | string | Bot's full Matrix user ID |
| `accessToken` | string | Access token for authentication |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable Matrix protocol |
| `deviceId` | string | auto | Device ID for E2EE |
| `encryption.enabled` | boolean | `false` | Enable E2EE support |
| `encryption.storePath` | string | `./matrix-store/` | Crypto key storage |
| `autoJoin` | boolean | `false` | Auto-join on invite |
| `sync.initialSyncLimit` | number | `10` | Initial sync message limit |
| `triggerPatterns` | string[] | `[]` | Patterns that trigger bot |
| `modes` | object | global modes | Protocol-specific mode mappings |
| `ignoreRooms` | string[] | `[]` | Room IDs to ignore |
| `ignoreUsers` | string[] | `[]` | User IDs to ignore |

### Getting Matrix Credentials

1. **Create a Matrix account** for your bot at matrix.org or your homeserver
2. **Get access token** from Element: Settings → Help & About → Access Token
3. **Note the user ID** in format `@username:server.org`

See [MATRIX_SETUP.md](MATRIX_SETUP.md) for detailed instructions.

## Mode Commands

Mode commands let users switch between OpenCode agents:

```json
{
  "modes": {
    "!s": "serious",    // Serious mode with tools
    "!d": "sarcastic",  // Witty responses
    "!a": "agent",      // Multi-turn research
    "!p": "plan"        // Planning without edits
  }
}
```

Usage: `@bot: !a research Python async patterns`

Modes can be defined globally or per-protocol (protocol overrides global).

## Session Persistence

Sessions are persisted to allow continuity across restarts:

```json
{
  "sessionStorePath": "./.opencode/chat-sessions.json"
}
```

Session data stored:
- Room ID → Session ID mapping
- Protocol name
- Creation timestamp
- Last activity timestamp
- Session title

Sessions older than 7 days are automatically cleaned up.

## OpenCode Integration

### Recommended OpenCode Config

For chat bot use cases, lock down permissions:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-chat-bridge"],
  
  "permission": {
    "*": "deny",
    "webfetch": "allow",
    "read": "deny",
    "edit": "deny",
    "bash": "deny",
    "external_directory": "deny"
  },
  
  "mcp": {
    "your-knowledge-base": {
      "type": "local",
      "command": ["python", "-m", "your_kb.mcp"]
    }
  },
  
  "agent": {
    "serious": {
      "mode": "primary",
      "description": "Helpful assistant",
      "permission": {
        "*": "deny",
        "webfetch": "allow"
      }
    }
  }
}
```

### Custom Agents

Define custom agents for your use case:

```json
{
  "agent": {
    "osgeo-helper": {
      "mode": "primary",
      "description": "OSGeo knowledge assistant",
      "prompt": "You are an expert on OSGeo projects. Use the knowledge_base tool first for OSGeo-related questions.",
      "permission": {
        "*": "deny",
        "webfetch": "allow"
      }
    }
  }
}
```

Then map to a mode command:

```json
{
  "modes": {
    "!o": "osgeo-helper"
  }
}
```

## Example Configurations

### Minimal Matrix Setup

```json
{
  "matrix": {
    "enabled": true,
    "homeserver": "https://matrix.org",
    "userId": "@mybot:matrix.org",
    "accessToken": "{env:MATRIX_TOKEN}"
  }
}
```

### Production Matrix Setup

```json
{
  "matrix": {
    "enabled": true,
    "homeserver": "https://matrix.org",
    "userId": "@production-bot:matrix.org",
    "accessToken": "{env:MATRIX_ACCESS_TOKEN}",
    "deviceId": "PROD_BRIDGE_001",
    "encryption": {
      "enabled": true,
      "storePath": "/var/lib/opencode-bridge/matrix-store/"
    },
    "autoJoin": false,
    "triggerPatterns": ["@production-bot:", "!ai "],
    "ignoreUsers": ["@known-spammer:example.com"]
  },
  "sessionStorePath": "/var/lib/opencode-bridge/sessions.json",
  "defaultAgent": "production-assistant"
}
```

### Multi-Protocol Setup (Future)

```json
{
  "matrix": {
    "enabled": true,
    "homeserver": "https://matrix.org",
    "userId": "@bot:matrix.org",
    "accessToken": "{env:MATRIX_TOKEN}"
  },
  "discord": {
    "enabled": true,
    "token": "{env:DISCORD_TOKEN}"
  },
  "irc": {
    "enabled": true,
    "server": "irc.libera.chat",
    "nick": "opencode-bot",
    "channels": ["#opencode"]
  }
}
```
