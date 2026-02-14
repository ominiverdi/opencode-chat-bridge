# Configuration Reference

This document describes all configuration options for opencode-chat-bridge.

## Quick Setup

1. Create `opencode.json` with the `chat-bridge` agent
2. Run `bun src/cli.ts`

## opencode.json (Required)

The `opencode.json` file defines the secure agent configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "chat-bridge",
  "agent": {
    "chat-bridge": {
      "description": "Secure chat assistant",
      "mode": "primary",
      "prompt": "You are a helpful assistant. You can search the web and check time.",
      "permission": {
        "read": "deny",
        "edit": "deny",
        "bash": "deny",
        "glob": "deny",
        "grep": "deny",
        "task": "deny",
        "todowrite": "deny",
        "todoread": "deny",
        "webfetch": "deny",
        "codesearch": "deny",
        "question": "allow",
        "time_*": "allow",
        "weather_*": "allow",
        "web-search_*": "allow"
      }
    }
  }
}
```

### Key Settings

| Setting | Description |
|---------|-------------|
| `default_agent` | Agent used by default for new sessions |
| `agent.*.mode` | `"primary"` for main agents, `"subagent"` for helpers |
| `agent.*.prompt` | System prompt for the agent |
| `agent.*.permission` | Tool permissions (allow/deny/ask) |

## Permission Configuration

### Permission Actions

| Action | Behavior |
|--------|----------|
| `"allow"` | Tool executes immediately |
| `"deny"` | Tool blocked, error returned to LLM |
| `"ask"` | Requires user confirmation |

For chat bots, use `"allow"` or `"deny"`. The `"ask"` action requires interactive confirmation.

### Tool Names

Built-in tools:
- `read` - Read files
- `edit` - Edit files
- `bash` - Execute commands
- `glob` - Find files
- `grep` - Search file contents
- `task` - Spawn subagents
- `todowrite` - Write todos
- `todoread` - Read todos
- `webfetch` - Fetch URLs
- `codesearch` - Search code
- `question` - Ask user questions

### MCP Tool Permissions

MCP tools use the pattern `<server>_<tool>`:

```json
{
  "permission": {
    "time_*": "allow",
    "weather_*": "allow",
    "web-search_*": "allow"
  }
}
```

**Wildcard matching:** `*` matches any characters, so `weather_*` allows all weather tools.

### Available MCP Servers

Check installed MCP servers:

```bash
opencode mcp list
```

Common servers:

| Server | Tools |
|--------|-------|
| `time` | `time_get_current_time`, `time_convert_time` |
| `weather` | `weather_get_weather`, `weather_get_forecast`, `weather_search_location` |
| `web-search` | `web-search_full-web-search`, `web-search_get-web-search-summaries`, `web-search_get-single-web-page-content` |
| `chrome-devtools` | Browser automation (deny for chat bots) |

Any MCP server can be used. Check available servers with `opencode mcp list`.

### Disabling MCP Servers Locally

Your global OpenCode config (`~/.config/opencode/opencode.json`) may have MCP servers enabled that you don't want the chat bot to use. You can disable them in your local project config.

**Problem:** Global config has `chrome-devtools` enabled, but you don't want the chat bot to use it.

**Solution:** Add an `mcp` section to your project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "default_agent": "chat-bridge",
  
  "mcp": {
    "chrome-devtools": {
      "enabled": false
    }
  },
  
  "agent": {
    "chat-bridge": {
      ...
    }
  }
}
```

**How it works:**
- Local config **overrides** global config
- You only need to specify `"enabled": false"` - not the full server definition
- Other MCP servers (time, weather, web-search) remain enabled from global config

**Important:** Disabling the MCP server prevents tools from being loaded. But the model may still "think" it has access if tools were visible in a previous session. For complete blocking, combine with permission denials:

```json
{
  "mcp": {
    "chrome-devtools": { "enabled": false }
  },
  
  "agent": {
    "chat-bridge": {
      "permission": {
        "chrome-devtools_*": "deny"
      }
    }
  }
}
```

The wildcard `chrome-devtools_*` denies ALL tools from that MCP server.

### Disabling a Whole MCP Server vs Single Functions

There are two ways to block MCP tools:

#### Method 1: Disable the Entire MCP Server

Use the `mcp` section to prevent the server from loading at all:

```json
{
  "mcp": {
    "chrome-devtools": {
      "enabled": false
    }
  }
}
```

This completely disables ALL tools from that server. The tools won't be loaded or visible to the model.

#### Method 2: Deny Individual Functions

Use the `permission` section to block specific tools while keeping others:

```json
{
  "agent": {
    "chat-bridge": {
      "permission": {
        "weather_set_default_location": "deny"
      }
    }
  }
}
```

This allows most weather tools but blocks the one that saves state.

#### Method 3: Wildcard Deny All Functions from an MCP

Use `*` to deny all tools from a server without disabling it:

```json
{
  "agent": {
    "chat-bridge": {
      "permission": {
        "chrome-devtools_*": "deny"
      }
    }
  }
}
```

#### Comparison

| Goal | Method | Config |
|------|--------|--------|
| Block entire MCP server | MCP disable | `"mcp": { "server": { "enabled": false } }` |
| Block all tools from MCP | Wildcard deny | `"permission": { "server_*": "deny" }` |
| Block one specific tool | Single deny | `"permission": { "server_tool": "deny" }` |
| Allow one tool, block rest | Selective | `"server_*": "deny"` + `"server_tool": "allow"` |

#### Example: Allow Only Some web-search Tools

```json
{
  "permission": {
    "web-search_*": "deny",
    "web-search_get-web-search-summaries": "allow"
  }
}
```

This denies all web-search tools by default, then explicitly allows only the lightweight summary search.

### Why Both MCP Disable AND Permission Deny?

| Method | What it does |
|--------|--------------|
| `mcp.enabled: false` | Server not loaded, tools don't appear |
| `permission: deny` | Tools blocked at execution time |

Using both provides defense in depth:
1. MCP disable prevents tools from loading
2. Permission deny blocks execution if tools somehow load
3. The model won't list capabilities it can't use



## Matrix HTML Formatting

By default, bot responses are sent as plain text. When `formatHtml` is enabled,
the Matrix connector converts markdown responses to HTML before sending, using
the Matrix `formatted_body` field. Matrix clients render the HTML while plain
text clients (IRC bridges, etc.) see the unformatted fallback.

### Enable in chat-bridge.json

```json
{
  "matrix": {
    "formatHtml": true
  }
}
```

### What it does

| With `formatHtml: false` (default) | With `formatHtml: true` |
|-------------------------------------|-------------------------|
| `sendText()` - plain text only | `sendMessage()` with `format: org.matrix.custom.html` |
| Markdown syntax visible as raw text | Tables, bold, lists rendered natively |
| Works on all clients equally | HTML for Matrix, plain text fallback for others |

### When to use it

- Enable when your primary audience uses Matrix/Element clients
- Leave disabled for IRC-bridged rooms or plain text environments
- The plain text `body` is always included as a fallback

## CLI Options

```bash
# Interactive mode
bun src/cli.ts

# Single prompt
bun src/cli.ts "What time is it?"
```

### Interactive Commands

| Command | Description |
|---------|-------------|
| `exit` | Exit the CLI |
| `quit` | Exit the CLI |

## Agent Configuration

### Multiple Agents

Define multiple agents for different purposes:

```json
{
  "agent": {
    "chat-bridge": {
      "description": "Secure chat assistant",
      "mode": "primary",
      "permission": {
        "read": "deny",
        "bash": "deny"
      }
    },
    "researcher": {
      "description": "Deep research mode",
      "mode": "primary",
      "permission": {
        "web-search_*": "allow"
      }
    },
    "coder": {
      "description": "Code-focused assistant",
      "mode": "primary",
      "permission": {
        "read": "allow",
        "glob": "allow",
        "grep": "allow",
        "edit": "deny"
      }
    }
  }
}
```

### Agent Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `mode` | `"primary"` or `"subagent"` | `"all"` |
| `description` | Human-readable description | - |
| `prompt` | System prompt | OpenCode default |
| `model` | LLM model override | Config default |
| `temperature` | Response randomness | Model default |
| `permission` | Tool permissions | Config default |

## Model Configuration

### Default Model

**IMPORTANT:** You MUST set the `model` field in `opencode.json`. Without it, OpenCode defaults to `opencode/big-pickle` (a free but less capable model).

Set in `opencode.json`:

```json
{
  "model": "anthropic/claude-sonnet-4-5"
}
```

### Per-Agent Model

Override for specific agents:

```json
{
  "agent": {
    "fast-helper": {
      "model": "anthropic/claude-haiku-4-5",
      "permission": { "read": "deny" }
    }
  }
}
```

### Available Models

Check available models:

```bash
opencode model list
```

Common models:
- `anthropic/claude-sonnet-4-*` - Good balance
- `anthropic/claude-opus-4-*` - Most capable
- `anthropic/claude-haiku-4-*` - Fastest
- `openai/gpt-4o` - OpenAI
- `google/gemini-*` - Google

## Environment Variables

Optional environment variables:

```bash
# OpenCode configuration
OPENCODE_MODEL="anthropic/claude-sonnet-4-20250514"
OPENCODE_CONFIG="/path/to/opencode.json"

# For chat connectors
MATRIX_ACCESS_TOKEN="syt_..."
DISCORD_TOKEN="..."
```

## Example Configurations

### Minimal (CLI Only)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "chat-bridge",
  "agent": {
    "chat-bridge": {
      "mode": "primary",
      "permission": {
        "read": "deny",
        "edit": "deny",
        "bash": "deny",
        "time_*": "allow",
        "web-search_*": "allow"
      }
    }
  }
}
```

### Full Production

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "default_agent": "chat-bridge",
  
  "mcp": {
    "chrome-devtools": { "enabled": false },
    "antigravity-img": { "enabled": false }
  },
  
  "agent": {
    "chat-bridge": {
      "description": "Secure chat assistant",
      "mode": "primary",
      "prompt": "You are a helpful assistant in a chat interface.\n\nYOUR CAPABILITIES (only these):\n1) Web search and fetching web pages\n2) Time and timezone queries\n3) Document library access\n\nYOU DO NOT HAVE:\n- Browser automation or Chrome DevTools\n- Image generation\n- Filesystem access\n- Code execution\n\nDo NOT mention capabilities you don't have.",
      "permission": {
        "read": "deny",
        "edit": "deny",
        "bash": "deny",
        "glob": "deny",
        "grep": "deny",
        "task": "deny",
        "todowrite": "deny",
        "todoread": "deny",
        "webfetch": "deny",
        "codesearch": "deny",
        "question": "allow",
        
        "chrome-devtools_*": "deny",
        "generate_image": "deny",
        "image_quota": "deny",
        
        "time_*": "allow",
        "weather_*": "allow",
        "web-search_*": "allow"
      }
    }
  }
}
```

This configuration allows time, weather, and web-search MCP tools while denying all filesystem and dangerous tools.

## Session Management

Bot sessions are stored **outside the project git repo** to prevent them from cluttering your OpenCode session list.

**Why outside the git repo?** OpenCode uses the git root to create a unique project hash. If session directories are inside the repo, all bot sessions end up in the same project hash as your dev sessions. By storing them outside (in `~/.cache/`), OpenCode assigns them to the `global` project instead, keeping them completely separate from your development sessions.

### Session Storage Location

**Default:** `~/.cache/opencode-chat-bridge/sessions/<connector>/<channel-id>/`

**Override:** Set `SESSION_BASE_DIR` environment variable:
```bash
SESSION_BASE_DIR=/path/to/sessions
```

### Session Directory Structure

```
~/.cache/opencode-chat-bridge/sessions/
  slack/
    C0ABC123/     # Slack channel session
    C0XYZ789/     # Another channel session
  matrix/
    _room1_server.org/  # Matrix room session (special chars sanitized)
  whatsapp/
    1234567890/   # WhatsApp chat session
```

### Session Cleanup

Old sessions are automatically cleaned up when connectors start:

```bash
# .env
SESSION_RETENTION_DAYS=7  # Default: 7 days
```

Sessions older than this are deleted on connector startup. This prevents disk space from growing unbounded.

### Session Commands

Users can manage their sessions via chat:

**Slack:**
- `!oc /status` - Show session info and directory location
- `!oc /clear` or `!oc /reset` - Clear session history
- `!oc /help` - Show available commands

**Matrix:**
- `!oc /status` - Show session info
- `!oc /clear` or `!oc /reset` - Clear session history
- `!oc /help` - Show available commands

**WhatsApp:**
- `!oc /status` - Show session info
- `!oc /clear` or `!oc /reset` - Clear session history
- `!oc /help` - Show available commands

### Session Continuity

Each channel/room/chat maintains one persistent session. Users can reference previous conversations as long as:
1. The session hasn't been manually cleared (`/clear`)
2. The session is less than `SESSION_RETENTION_DAYS` old
3. The connector hasn't been restarted (in-memory sessions are lost on restart)

### Debugging Sessions

To inspect a session directory:

```bash
ls -la ~/.cache/opencode-chat-bridge/sessions/slack/C0ABC123/
```

OpenCode stores session data in `~/.local/share/opencode/storage/session/<project-hash>/`. Since bot sessions are outside any git repo, they go to the `global` project (`~/.local/share/opencode/storage/session/global/`) instead of your dev project's hash.

To view session files for a specific bot session:

```bash
cd ~/.cache/opencode-chat-bridge/sessions/slack/C0ABC123
opencode session list
```

This won't pollute your main project session list since it's a different "project" (directory outside git).

## Troubleshooting

### "Agent not found"

Ensure `default_agent` matches an agent name:

```json
{
  "default_agent": "chat-bridge",
  "agent": {
    "chat-bridge": { ... }
  }
}
```

### "Tool blocked"

Check permission configuration. Tool calls are blocked if:
- Tool is set to `"deny"`
- Tool not explicitly allowed and no default `"*": "allow"`

### "No response"

1. Check OpenCode is installed: `opencode --version`
2. Check `opencode.json` exists in working directory
3. Check for errors in output

### "Wrong model being used" / "Big Pickle"

If the bot uses `opencode/big-pickle` instead of your intended model:

1. Add `"model": "anthropic/claude-sonnet-4-5"` to `opencode.json`
2. Without the `model` field, OpenCode defaults to free models
3. Verify with: `opencode models` to list available models

### "Images not displaying in Matrix"

If MCP tool images aren't showing in Matrix chat:

1. Tool results contain image path markers (e.g., `[DOCLIBRARY_IMAGE]...[/DOCLIBRARY_IMAGE]`)
2. These come in tool_result events, not in response text chunks
3. The Matrix connector captures tool results via `update` events
4. Check logs for `[IMAGE]` messages
