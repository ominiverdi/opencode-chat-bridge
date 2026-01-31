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
        "time_get_current_time": "allow",
        "time_convert_time": "allow",
        "web-search_full-web-search": "allow",
        "web-search_get-web-search-summaries": "allow",
        "web-search_get-single-web-page-content": "allow",
        "doclibrary_*": "allow"
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
    "time_get_current_time": "allow",
    "time_convert_time": "allow",
    "web-search_*": "allow",
    "doclibrary_*": "allow"
  }
}
```

**Wildcard matching:** `*` matches any characters, so `doclibrary_*` allows all doclibrary tools.

### Available MCP Servers

Check installed MCP servers:

```bash
opencode mcp list
```

Common servers:

| Server | Tools |
|--------|-------|
| `time` | `time_get_current_time`, `time_convert_time` |
| `web-search` | `web-search_full-web-search`, `web-search_get-web-search-summaries`, `web-search_get-single-web-page-content` |
| `doclibrary` | `doclibrary_search_documents`, `doclibrary_list_documents`, etc. |
| `chrome-devtools` | Browser automation (deny for chat bots) |

## CLI Options

```bash
# Interactive mode
bun src/cli.ts

# Single prompt
bun src/cli.ts "What time is it?"

# With a skill
bun src/cli.ts --skill=sarcastic "Tell me a joke"

# List available skills
bun src/cli.ts --list-skills
```

### Interactive Commands

| Command | Description |
|---------|-------------|
| `/skills` | List available skills |
| `/skill <name>` | Switch to a skill |
| `exit` | Exit the CLI |
| `quit` | Exit the CLI |

## Skills Configuration

Create skills in `skills/*.md`:

```markdown
---
description: Witty assistant with humor
---

# Sarcastic Mode

You are a witty, sarcastic assistant. Add humor to your responses while still being helpful.

Rules:
- Keep responses concise
- Use clever wordplay
- Be helpful despite the snark
```

### Skill Metadata

| Field | Description |
|-------|-------------|
| `description` | Shown in `--list-skills` output |

The content after the frontmatter becomes the system prompt.

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
  "model": "anthropic/claude-sonnet-4-20250514",
  "default_agent": "chat-bridge",
  
  "agent": {
    "chat-bridge": {
      "description": "Secure chat assistant",
      "mode": "primary",
      "prompt": "You are a helpful assistant that can search the web and check time. Keep responses concise.",
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
        "time_get_current_time": "allow",
        "time_convert_time": "allow",
        "web-search_full-web-search": "allow",
        "web-search_get-web-search-summaries": "allow",
        "web-search_get-single-web-page-content": "allow",
        "doclibrary_search_documents": "allow",
        "doclibrary_search_visual_elements": "allow",
        "doclibrary_list_elements": "allow",
        "doclibrary_get_element_details": "allow",
        "doclibrary_list_documents": "allow",
        "doclibrary_get_library_status": "allow",
        "doclibrary_get_page_image": "allow",
        "doclibrary_get_element_image": "allow",
        "doclibrary_get_document_info": "allow",
        "doclibrary_find_document": "allow",
        "doclibrary_list_documents_paginated": "allow"
      }
    }
  }
}
```

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

### "Skill not found"

1. Check skill file exists in `skills/` directory
2. Check file extension is `.md`
3. Check frontmatter is valid YAML

### "Wrong model being used" / "Big Pickle"

If the bot uses `opencode/big-pickle` instead of your intended model:

1. Add `"model": "anthropic/claude-sonnet-4-5"` to `opencode.json`
2. Without the `model` field, OpenCode defaults to free models
3. Verify with: `opencode models` to list available models

### "Images not displaying in Matrix"

If doclibrary images aren't showing in Matrix chat:

1. Tool results contain `[DOCLIBRARY_IMAGE]...[/DOCLIBRARY_IMAGE]` markers
2. These come in tool_result events, not in response text chunks
3. The Matrix connector captures tool results via `update` events
4. Check logs for `[IMAGE] Found doclibrary image` messages
