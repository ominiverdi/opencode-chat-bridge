# Mattermost Setup Guide

This guide walks through setting up the Mattermost connector for OpenCode Chat Bridge.

## Overview

The Mattermost connector uses the **REST API v4** and **WebSocket** for real-time messaging. It requires zero external npm dependencies -- only native `fetch` and `WebSocket` (built into Bun and Node.js 22+). This makes it lightweight and easy to deploy on any Mattermost instance (self-hosted or cloud).

**How it works:**
1. The bot authenticates with a bot access token
2. A WebSocket connection receives real-time message events
3. Messages matching the trigger prefix or @mentions are forwarded to OpenCode
4. Responses are sent back via the REST API

## Prerequisites

- A Mattermost server (self-hosted or cloud) with admin access
- `bun` runtime installed
- OpenCode installed and authenticated (`opencode --version`)

## Step 1: Create a Bot Account

1. Log in to your Mattermost server as an admin
2. Go to **Integrations > Bot Accounts** (not System Console > Bot Accounts, which is just settings)
3. Click **Add Bot Account**
4. Fill in:
   - **Username**: your bot name (e.g., `my-opencode-bot`)
   - **Display Name**: friendly name shown in conversations
   - **Description**: optional
   - **Role**: Member (sufficient for most use cases)
5. Click **Create Bot Account**
6. **Copy the Access Token** -- this is your `MATTERMOST_TOKEN`

**Important:** The token is only shown once. If you lose it, you can regenerate it from the bot account settings.

## Step 2: Add the Bot to a Team

Bots must be added to a team before they can see channels or receive messages.

1. Go to the team you want the bot to join
2. Open **Team Settings > Members**
3. Add the bot user to the team

Alternatively, use the Mattermost API:

```bash
curl -X POST "https://mattermost.example.com/api/v4/teams/TEAM_ID/members" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"team_id": "TEAM_ID", "user_id": "BOT_USER_ID"}'
```

To find the team ID and bot user ID:

```bash
# Get team ID by name
curl -s "https://mattermost.example.com/api/v4/teams/name/myteam" \
  -H "Authorization: Bearer ADMIN_TOKEN" | jq .id

# Get bot user ID
curl -s "https://mattermost.example.com/api/v4/users/username/my-opencode-bot" \
  -H "Authorization: Bearer ADMIN_TOKEN" | jq .id
```

## Step 3: Configure Environment

Add credentials to your `.env` file:

```bash
MATTERMOST_URL=https://mattermost.example.com
MATTERMOST_TOKEN=your_bot_access_token

# Team name/slug (optional -- auto-detected if bot is in one team)
# MATTERMOST_TEAM=myteam
```

And configure the connector in `chat-bridge.json`:

```json
{
  "mattermost": {
    "enabled": true,
    "url": "{env:MATTERMOST_URL}",
    "token": "{env:MATTERMOST_TOKEN}",
    "teamName": "",
    "respondToMentions": true,
    "ignoreChannels": [],
    "ignoreUsers": []
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the Mattermost connector |
| `url` | string | `""` | Mattermost server URL |
| `token` | string | `""` | Bot access token |
| `teamName` | string | `""` | Team slug (empty = auto-detect) |
| `respondToMentions` | boolean | `true` | Respond when @mentioned (in addition to trigger) |
| `ignoreChannels` | string[] | `[]` | Channel IDs to ignore |
| `ignoreUsers` | string[] | `[]` | User IDs to ignore |

## Step 4: Run the Connector

```bash
bun connectors/mattermost.ts
```

You should see:

```
[MATTERMOST] Starting...
  Server: https://mattermost.example.com
  Trigger: !oc
  Bot name: OpenCode Bot
  Bot user: @my-opencode-bot (abc123def456)
  Responds to: trigger "!oc" and @my-opencode-bot mentions
[MATTERMOST] WebSocket authenticated
[MATTERMOST] Started! Listening for messages...
```

## Step 5: Test in Mattermost

Go to any channel in the configured team and send:

```
!oc hello
```

Or @mention the bot:

```
@my-opencode-bot hello
```

## Usage

### Trigger Prefix

Messages in channels must start with the trigger (default: `!oc`) or @mention the bot:

```
!oc what time is it?
!oc search the web for climate change
@my-opencode-bot who are you?
```

### Direct Messages

In DMs with the bot, no trigger or @mention is needed:

```
what time is it?
search for map projections
```

### Commands

| Command | Description |
|---------|-------------|
| `!oc /help` | Show available commands (including OpenCode commands) |
| `!oc /status` | Show session info and directory |
| `!oc /clear` | Reset conversation session |
| `!oc /reset` | Same as /clear |

### OpenCode Commands

OpenCode's built-in commands are discovered and forwarded automatically:

```
!oc /init          # Initialize context with codebase summary
!oc /compact       # Compress conversation history
!oc /review        # Review recent changes
```

These appear in `/help` and are passed directly to OpenCode.

## Features

### Activity Logging

The bot shows what tools are being used during processing:

```
> command=free -h | grep Mem, description=Get memory usage [bash]
> Getting time in Europe/Madrid [time_get_current_time]
```

### Session Isolation

Each channel and DM has its own conversation session. Users can reference previous
messages within the same channel. Use `/clear` to reset.

### @Mention Support

When `respondToMentions` is enabled (default), the bot responds to both the trigger
prefix and @mentions. The bot username is resolved from the API on startup:

```
!oc what time is it?          # Trigger prefix
@my-opencode-bot what time is it?   # @mention
```

Disable with `"respondToMentions": false` in `chat-bridge.json` if you only want
trigger-based activation.

### Image Uploads

When tools produce image files (e.g., from a document library MCP), the connector
uploads them to Mattermost as file attachments.

### Message Splitting

Mattermost has a 16,383 character limit per post. Long responses are automatically
split at newline boundaries into multiple messages.

### Tool Output Streaming

When `streamTools` includes a tool name (default: `["bash"]`), the tool's output
is streamed to chat in real-time during execution. This is useful for long-running
commands where you want to see progress.

## Running as a Service

For production, create a systemd service:

### `/etc/systemd/system/opencode-mattermost.service`

```ini
[Unit]
Description=OpenCode Mattermost Bridge
After=network.target

[Service]
Type=simple
User=youruser
Group=youruser
WorkingDirectory=/home/youruser/opencode-chat-bridge
Environment=PATH=/home/youruser/.bun/bin:/home/youruser/.opencode/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/youruser
ExecStart=/home/youruser/.bun/bin/bun connectors/mattermost.ts
Restart=always
RestartSec=10

StandardOutput=journal
StandardError=journal
SyslogIdentifier=opencode-mattermost

[Install]
WantedBy=multi-user.target
```

**Note:** Adjust paths for your bun and opencode installations.

### Start the Service

```bash
sudo systemctl daemon-reload
sudo systemctl enable opencode-mattermost
sudo systemctl start opencode-mattermost

# Check status
sudo systemctl status opencode-mattermost

# View logs
journalctl -u opencode-mattermost -f
```

## Architecture

```
Mattermost Server
    | (WebSocket wss://server/api/v4/websocket)
    v
Mattermost Connector (connectors/mattermost.ts)
    | (ACP Protocol - JSON-RPC/stdio)
    v
OpenCode
    | (LLM API)
    v
AI Response
    | (REST API POST /api/v4/posts)
    v
Mattermost Server
```

The connector maintains one ACP session (OpenCode process) per channel, allowing
conversation continuity within each channel.

## Security Considerations

### Token Security

- Keep `MATTERMOST_TOKEN` secret -- never commit `.env` to git
- Use a dedicated bot account, not a personal access token
- Store tokens in a secrets manager (e.g., HashiCorp Vault) for production

### Channel Restrictions

- The bot only sees channels in teams it has been added to
- Use `ignoreChannels` to exclude specific channels
- Use `ignoreUsers` to block specific users from interacting

### Permission Isolation

The bot uses the `chat-bridge` agent with restricted permissions defined in
`opencode.json`. Even if a malicious prompt tricks the model, OpenCode blocks
the action at the execution level.

### Rate Limiting

Built-in rate limiting prevents spam (configurable, default: 5 second cooldown per user).

## Troubleshooting

### Bot Doesn't Respond

1. Check the bot is added to the team (not just created)
2. Verify the message starts with the trigger (`!oc`) or @mentions the bot
3. Check that `respondToMentions` is `true` if using @mentions
4. Look at connector logs: `journalctl -u opencode-mattermost -f`
5. Test OpenCode directly: `bun src/cli.ts "test"`

### "Unauthorized" or 401 Error

- Regenerate the bot access token in **Integrations > Bot Accounts**
- Make sure you are using the bot token, not a personal access token
- Check the token hasn't been revoked by an admin

### WebSocket Disconnects

The connector automatically reconnects with exponential backoff (up to 10 attempts):

```
[MATTERMOST] WebSocket closed: 1006
[MATTERMOST] Reconnecting in 3000ms (attempt 1/10)...
[MATTERMOST] Reconnected successfully
```

If reconnection fails repeatedly:
- Check server logs for rate limiting
- Verify the server allows WebSocket connections
- Check network/firewall rules

### Bot Not Receiving Messages

- Verify WebSocket is connected (check logs for "WebSocket authenticated")
- Ensure the bot has permissions in the channel
- Check if the message is from a user in the `ignoreUsers` list
- Check if the channel is in the `ignoreChannels` list

### "Permission denied" in Responses

This is expected behavior -- the `opencode.json` restricts what tools the AI can use.
For example, if the AI tries to read files but `read: deny` is set, OpenCode blocks
it and returns an error to the model. See [Security](SECURITY.md) for details.

## Next Steps

- Review [Security documentation](SECURITY.md) for permission details
- See [Architecture](ARCHITECTURE.md) for system design
- See [Configuration](CONFIGURATION.md) for all config options
- Check [Contributing](CONTRIBUTING.md) to help improve the connector
