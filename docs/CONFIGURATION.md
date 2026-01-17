# Configuration Reference

This document describes all configuration options for opencode-chat-bridge standalone mode.

## Quick Setup

The standalone bridge requires minimal configuration:

1. **Environment variable** - Matrix access token
2. **standalone.ts** - Bot user ID and trigger patterns
3. **opencode.json** - Model and permissions

## IMPORTANT: opencode.json is Required

The `opencode.json` file is **mandatory** for the bridge to work. Without it:
- Prompts fail with `TypeError: agent.name undefined`
- Bot responds with "No response generated"

**Never use the `plugin` line** in your config:
```json
// DO NOT USE - causes "Cannot call a class constructor" error
"plugin": ["./src/index.ts"]
```

The plugin approach is documented in `src/` but does not work due to ESM/bundling issues with OpenCode's plugin loader.

## MCP Tool Permissions

MCP tools follow the naming pattern `<servername>_<toolname>` (single underscore).

**Examples:**
- `doclibrary_list_documents`
- `doclibrary_search_documents`  
- `time_get_current_time`
- `web-search_full-web-search`

### Permission Patterns

**Allow all MCP tools:**
```json
"permission": {
  "*": "deny",
  "mcp": "allow"
}
```

**Allow specific MCP server:**
```json
"permission": {
  "*": "deny",
  "doclibrary_*": "allow",
  "time_*": "allow"
}
```

**Allow specific tools:**
```json
"permission": {
  "*": "deny",
  "doclibrary_list_documents": "allow",
  "doclibrary_search_documents": "allow"
}
```

Note: The glob pattern `*` matches zero or more characters. So `doclibrary_*` matches all tools from the doclibrary MCP server.

## Environment Variables

Create a `.env` file:

```bash
# Required: Matrix access token
MATRIX_ACCESS_TOKEN="syt_your_token_here"

# Optional: OpenCode server URL (default: http://127.0.0.1:4096)
OPENCODE_URL="http://127.0.0.1:4096"
```

## Standalone Configuration

Edit `standalone.ts` to customize:

```typescript
// OpenCode server
const OPENCODE_URL = process.env.OPENCODE_URL || 'http://127.0.0.1:4096'

// Matrix settings
const MATRIX_HOMESERVER = 'https://matrix.org'
const MATRIX_USER_ID = '@your-bot:matrix.org'
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN

// Message patterns that trigger the bot
const TRIGGER_PATTERNS = ['@your-bot:', '!oc ']

// Mode command mappings
const MODES: Record<string, string> = {
  '!s': 'serious',
  '!d': 'sarcastic',
  '!a': 'agent',
  '!p': 'plan',
}
```

### Trigger Patterns

Messages containing any trigger pattern will be processed:

```typescript
// Examples that would trigger:
// "@your-bot: hello" -> "hello"
// "!oc what is QGIS?" -> "what is QGIS?"
// "Hey @your-bot: help" -> "Hey  help"

const TRIGGER_PATTERNS = [
  '@your-bot:',    // Mention
  '!oc ',          // Command prefix
  '!ai ',          // Alternative prefix
]
```

### Mode Commands

Mode commands switch between OpenCode agents:

```typescript
const MODES = {
  '!s': 'serious',    // Default helpful mode
  '!d': 'sarcastic',  // Witty responses
  '!a': 'agent',      // Multi-turn research
  '!p': 'plan',       // Planning without edits
  '!r': 'researcher', // Custom agent
}
```

Usage: `!oc !s explain async/await`

The mode prefix is stripped, and the remaining text is sent to the specified agent.

## OpenCode Configuration

Create `opencode.json` in the project directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  
  "model": "anthropic/claude-sonnet-4-20250514",
  
  "permission": {
    "*": "deny",
    "webfetch": "allow",
    "read": "allow",
    "edit": "deny",
    "bash": "deny",
    "glob": "allow",
    "grep": "allow",
    "external_directory": "deny"
  },
  
  "agent": {
    "serious": {
      "mode": "primary",
      "description": "Helpful assistant for general questions",
      "model": "anthropic/claude-sonnet-4-20250514",
      "permission": {
        "*": "deny",
        "webfetch": "allow"
      }
    },
    "sarcastic": {
      "mode": "primary",
      "description": "Witty, humorous assistant",
      "model": "anthropic/claude-sonnet-4-20250514",
      "permission": {
        "*": "deny",
        "webfetch": "allow"
      }
    }
  }
}
```

### Model Selection

Specify the default model:

```json
{
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

Available providers:
- `anthropic/claude-sonnet-4-*` - Claude Sonnet 4
- `anthropic/claude-3-5-*` - Claude 3.5 models
- `openai/gpt-4o` - GPT-4o
- `google/gemini-*` - Gemini models

### Permissions

For chat bot use cases, lock down permissions:

```json
{
  "permission": {
    "*": "deny",           // Deny all by default
    "webfetch": "allow",   // Allow web fetching
    "read": "deny",        // No file reading
    "edit": "deny",        // No file editing
    "bash": "deny",        // No shell commands
    "external_directory": "deny"  // No access outside project
  }
}
```

Permission levels:
- `"allow"` - Always permit
- `"deny"` - Always deny
- `"ask"` - Prompt for confirmation (not useful for chat)

### Custom Agents

Define agents with specific capabilities:

```json
{
  "agent": {
    "researcher": {
      "mode": "primary",
      "description": "Deep research with web access",
      "model": "anthropic/claude-sonnet-4-20250514",
      "prompt": "You are a thorough researcher. Always cite sources.",
      "permission": {
        "*": "deny",
        "webfetch": "allow"
      }
    },
    "coder": {
      "mode": "primary",
      "description": "Code-focused assistant",
      "model": "anthropic/claude-sonnet-4-20250514",
      "permission": {
        "*": "deny",
        "read": "allow",
        "glob": "allow",
        "grep": "allow"
      }
    }
  }
}
```

### MCP Servers

Add custom tools via MCP:

```json
{
  "mcp": {
    "knowledge-base": {
      "type": "local",
      "command": ["python", "-m", "my_kb.mcp"]
    },
    "web-search": {
      "type": "local", 
      "command": ["npx", "web-search-mcp"]
    }
  }
}
```

## Getting Matrix Credentials

### Create Bot Account

1. Go to https://app.element.io
2. Create account (e.g., `my-opencode-bot`)
3. Note the full user ID: `@my-opencode-bot:matrix.org`

### Get Access Token

**Method 1: Element Web**
1. Log in to Element with bot account
2. Settings > Help & About
3. Scroll to "Access Token"
4. Click to reveal and copy

**Method 2: API**
```bash
curl -X POST "https://matrix.org/_matrix/client/r0/login" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "m.login.password",
    "user": "@mybot:matrix.org",
    "password": "your-password"
  }'
```

### Invite Bot to Rooms

The bot must be a member of rooms to respond:

1. Open room in Element
2. Room Settings > People > Invite
3. Enter bot's user ID

## Example Configurations

### Minimal Setup

`.env`:
```bash
MATRIX_ACCESS_TOKEN="syt_xxxxx..."
```

`opencode.json` (minimum required):
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

Note: The `agent` section with at least one agent is required. The standalone bridge uses the "serious" agent by default (via `!s` mode command).

### Production Setup (Default Personality)

Without a custom prompt, the bot uses Claude Code's default personality and automatically describes its available tools.

`.env`:
```bash
MATRIX_ACCESS_TOKEN="syt_xxxxx..."
OPENCODE_URL="http://127.0.0.1:4096"
```

`opencode.json`:
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
      "permission": {
        "*": "deny",
        "webfetch": "allow"
      }
    },
    "sarcastic": {
      "mode": "primary",
      "description": "Witty, humorous assistant",
      "model": "anthropic/claude-sonnet-4-20250514",
      "permission": {
        "*": "deny",
        "webfetch": "allow"
      }
    }
  }
}
```

### Production Setup (Custom Personality)

Use a custom `prompt` to give the bot a specialized personality:

`opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-20250514",
  
  "permission": {
    "*": "deny",
    "mcp": "allow"
  },
  
  "agent": {
    "serious": {
      "mode": "primary",
      "description": "Document library assistant",
      "model": "anthropic/claude-sonnet-4-20250514",
      "prompt": "You are a document library assistant responding via Matrix chat.\n\nRULES:\n1. PLAIN TEXT ONLY: No markdown formatting.\n2. SHORT ANSWERS: Maximum 2-3 sentences for simple questions.\n3. USE DOCLIBRARY MCP: For any library/document questions, use doclibrary tools.",
      "permission": {
        "*": "deny",
        "mcp": "allow"
      }
    }
  }
}
```

This creates a specialized assistant that identifies as a "document library assistant" instead of "Claude Code".

## Troubleshooting

### "MATRIX_ACCESS_TOKEN not set"

Ensure `.env` file exists and is sourced:
```bash
source .env
echo $MATRIX_ACCESS_TOKEN  # Should print token
```

### "Failed to connect to OpenCode"

1. Start OpenCode server first:
   ```bash
   opencode serve --port 4096
   ```
2. Check URL matches `OPENCODE_URL`
3. Verify server is running:
   ```bash
   curl http://127.0.0.1:4096/session
   ```

### "Bot not responding"

1. Check bot is in the room
2. Verify trigger pattern matches
3. Check logs for errors
4. Test with exact trigger: `!oc hello`

### "Access token invalid"

Tokens can expire. Generate a new one:
1. Log in to Element with bot account
2. Settings > Help & About > Access Token
3. Update `.env` and restart bridge
