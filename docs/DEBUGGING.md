# Debugging Guide

This guide explains how to investigate issues with the OpenCode chat bridge, particularly tool call failures and permission problems.

## Log Locations

| Location | Content |
|----------|---------|
| `/tmp/opencode.log` | Server startup output |
| `~/.local/share/opencode/log/` | Timestamped session logs |
| `~/.local/share/opencode/storage/session/` | Session metadata |
| `~/.local/share/opencode/storage/message/` | Message metadata |
| `~/.local/share/opencode/storage/part/` | Tool calls & responses (most useful!) |

## Checking MCP Status

### List Connected MCP Servers

```bash
curl -s http://127.0.0.1:4096/mcp | jq
```

Example output:
```json
{
  "chrome-devtools": { "status": "connected" },
  "web-search": { "status": "connected" },
  "time": { "status": "connected" },
  "doclibrary": { "status": "connected" }
}
```

### Check MCP Loading in Startup Logs

```bash
# Find the latest log
ls -lt ~/.local/share/opencode/log/ | head -5

# Check MCP initialization
cat ~/.local/share/opencode/log/YYYY-MM-DDTHHMMSS.log | grep mcp
```

Example output showing successful MCP loading:
```
INFO  service=mcp key=web-search toolCount=3 create() successfully created client
INFO  service=mcp key=time toolCount=2 create() successfully created client
INFO  service=mcp key=doclibrary toolCount=11 create() successfully created client
INFO  service=mcp key=chrome-devtools toolCount=26 create() successfully created client
```

## Investigating Tool Call Failures

When a tool call fails or produces unexpected results, follow this process:

### Step 1: Find the Project ID

```bash
# List projects
ls ~/.local/share/opencode/storage/session/
```

For opencode-chat-bridge, the project ID is based on the directory hash.

### Step 2: Find Recent Sessions

```bash
# List sessions for a project, sorted by time
ls -lt ~/.local/share/opencode/storage/session/<project-id>/ | head -10
```

### Step 3: Find Messages in a Session

```bash
# List messages in a session
ls -lt ~/.local/share/opencode/storage/message/<session-id>/ | head -20
```

Messages are named `msg_<id>.json` and contain metadata about each exchange.

### Step 4: Read the Tool Call Parts (Most Important!)

The actual tool calls and their results are stored in the `part` directory:

```bash
# List parts for a specific message
ls ~/.local/share/opencode/storage/part/<message-id>/

# Read all parts for a message
cat ~/.local/share/opencode/storage/part/<message-id>/*.json
```

## Understanding Part Files

Part files contain the actual tool invocations. Key fields:

```json
{
  "type": "tool",
  "tool": "time_get_current_time",
  "state": {
    "status": "error",
    "input": { "timezone": "Europe/Madrid" },
    "error": "Model tried to call unavailable tool 'invalid'. Available tools: webfetch."
  }
}
```

| Field | Meaning |
|-------|---------|
| `type` | "tool" for tool calls, "step-start"/"step-finish" for boundaries |
| `tool` | The tool name that was called |
| `state.status` | "completed" or "error" |
| `state.input` | The parameters passed to the tool |
| `state.output` | The tool's response (if completed) |
| `state.error` | Error message (if failed) |

## Common Issues and How to Debug

### Issue: "No response generated"

**Symptom:** Bot responds with "No response generated" in Matrix.

**Debug steps:**
1. Check if `opencode.json` exists
2. Check server logs for `agent.name undefined` error
3. Ensure at least one agent is defined in config

### Issue: "Model tried to call unavailable tool"

**Symptom:** Error in parts: `"Available tools: webfetch"`

**Debug steps:**
1. Check agent permissions in `opencode.json`
2. Look for what tool was actually attempted
3. Compare with allowed permissions

**Example discovery:**

We found that with `"webfetch": "allow"` permission:
- `time_get_current_time` FAILED (not permitted)
- Model worked around it by using `webfetch` to fetch timeanddate.com
- `doclibrary` tools FAILED (no workaround possible)

The parts file revealed:
```json
{
  "tool": "webfetch",
  "state": {
    "status": "completed",
    "input": {
      "url": "https://www.timeanddate.com/worldclock/spain/barcelona"
    }
  }
}
```

This showed the model used webfetch as a workaround, not the actual time MCP!

### Issue: MCP tools not available

**Symptom:** MCP servers show "connected" but tools fail.

**Cause:** Agent permissions don't allow MCP tools.

**MCP Tool Naming:** Tools follow the pattern `<servername>_<toolname>`:
- `doclibrary_list_documents`
- `time_get_current_time`
- `web-search_full-web-search`

**Fix Options:**

Option 1 - Allow all MCP tools:
```json
"permission": {
  "*": "deny",
  "mcp": "allow"
}
```

Option 2 - Allow specific MCP server:
```json
"permission": {
  "*": "deny",
  "doclibrary_*": "allow",
  "time_*": "allow"
}
```

Option 3 - Allow specific tools:
```json
"permission": {
  "*": "deny",
  "doclibrary_list_documents": "allow"
}
```

**Important:** After changing permissions, restart the OpenCode server AND create a new session (restart Matrix bridge) for changes to take effect.

## Quick Debug Commands

```bash
# Check if server is running
curl -s http://127.0.0.1:4096/session | jq length

# Check MCP status
curl -s http://127.0.0.1:4096/mcp | jq

# Find latest Matrix session
ls -lt ~/.local/share/opencode/storage/message/ | grep ses_ | head -5

# Read tool calls for a message
SESSION="ses_xxxxx"
MSG="msg_xxxxx"
cat ~/.local/share/opencode/storage/part/$MSG/*.json | jq -s '.'

# Search for errors in parts
find ~/.local/share/opencode/storage/part/ -name "*.json" -newer /tmp/marker -exec grep -l "error" {} \;
```

## Session Storage Structure

```
~/.local/share/opencode/storage/
├── session/           # Session metadata by project
│   └── <project-id>/
│       └── ses_xxx.json
├── message/           # Message metadata by session
│   └── <session-id>/
│       └── msg_xxx.json
└── part/              # Tool calls and responses by message
    └── <message-id>/
        ├── prt_xxx.json  # step-start
        ├── prt_xxx.json  # tool call
        └── prt_xxx.json  # step-finish
```

## Key Insight: Models Work Around Missing Tools

When a model can't use a specific tool, it may find workarounds:
- Can't use `time` MCP? Fetch time from a website with `webfetch`
- Can't use `web-search`? Use `webfetch` on a search engine

This can make it appear that tools are working when they're actually being worked around. Always check the actual tool calls in the parts files to verify what's really happening.
