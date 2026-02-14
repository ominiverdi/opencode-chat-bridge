# Matrix Setup Guide

This guide walks through setting up the Matrix connector for OpenCode Chat Bridge.

## Prerequisites

- A Matrix account for your bot
- `bun` runtime installed
- **Node.js 22+** (required for native crypto bindings)
- OpenCode installed and authenticated (`opencode --version`)

## Step 1: Create Bot Account

### Option A: matrix.org (Public)

1. Go to https://app.element.io
2. Click "Create Account"
3. Choose a username like `my-opencode-bot`
4. Complete registration
5. Note your full user ID: `@my-opencode-bot:matrix.org`

### Option B: Self-Hosted Homeserver

If you run your own Synapse/Dendrite:

```bash
# Synapse example
register_new_matrix_user -c /etc/synapse/homeserver.yaml http://localhost:8008
```

## Step 2: Get Access Token

### Method A: Element Web (Easiest)

1. Log in to Element Web with your bot account
2. Go to Settings (gear icon)
3. Click "Help & About"
4. Scroll down to "Access Token"
5. Click to reveal and copy

### Method B: API Call

```bash
curl -X POST "https://matrix.org/_matrix/client/r0/login" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "m.login.password",
    "user": "@mybot:matrix.org",
    "password": "your-password"
  }'
```

Response:
```json
{
  "user_id": "@mybot:matrix.org",
  "access_token": "syt_xxxxx...",
  "device_id": "ABCDEFGH"
}
```

## Step 3: Configure Environment

Add credentials to your `.env` file:

```bash
MATRIX_HOMESERVER=https://matrix.org
MATRIX_USER_ID=@my-opencode-bot:matrix.org
MATRIX_TRIGGER=!oc

# Option A: Password login (recommended - handles token refresh)
MATRIX_PASSWORD=your-bot-password

# Option B: Access token (manual - may expire)
# MATRIX_ACCESS_TOKEN=syt_xxxxx...
```

**Recommended:** Use password login. The bot will automatically obtain and cache an access token.

## Step 4: Run the Connector

```bash
bun connectors/matrix.ts
```

You should see:
```
Starting Matrix connector...
  Homeserver: https://matrix.org
  User: @my-opencode-bot:matrix.org
  Trigger: !oc
Matrix connector started! Listening for messages...
```

## Step 5: Invite Bot to Rooms

The bot will auto-join rooms when invited.

### Create a Test Room (Recommended)

1. In Element, click "+" > "New Room"
2. Name it "OpenCode Test"
3. **Important:** Make it **not encrypted** (easier for bots)
4. Invite your bot: `@my-opencode-bot:matrix.org`

The bot should join automatically and you'll see in the logs:
```
Invited to room: !roomid:matrix.org
Joined room: !roomid:matrix.org
```

## Usage

Once the bot is in a room:

```
!oc what time is it?
!oc search the web for machine learning
!oc show me page 50 of usgs_snyder
```

Or mention the bot directly:
```
@my-opencode-bot what's the weather?
```

### Commands

| Command | Description |
|---------|-------------|
| `!oc /help` | Show available commands |
| `!oc /status` | Show session info |
| `!oc /clear` | Reset conversation session |

## Features

### Activity Logging

The bot shows what tools are being used:
```
> Getting time in Europe/Madrid [time_get_current_time]
> Getting weather for Barcelona [weather_get_weather]
```

### Session Isolation

Each room has its own conversation session. Use `/clear` to reset.

### HTML Formatting

Enable rich HTML rendering in Matrix clients:

In :


When enabled, markdown from the LLM is converted to HTML. Matrix clients
render tables, bold text, code blocks, and lists natively. The plain text
version is always included as a fallback for non-Matrix clients.

## Security Considerations

### E2EE Support

The bot supports end-to-end encrypted rooms using native Rust crypto:

- **Automatic encryption/decryption** - messages in encrypted rooms just work
- **Persistent key storage** - crypto keys survive restarts (SQLite-backed)
- **Password login recommended** - tokens are cached automatically

**Storage location:** `~/.local/share/opencode-matrix-bot/`
- `bot-state.json` - sync state
- `crypto/` - encryption keys (back this up!)
- `access_token` - cached login token

**"Unverified device" warning:** This is cosmetic. E2EE works correctly. To remove it, verify the bot's device manually from Element (Settings > Security > Sessions).

### Permission Isolation

The bot uses the `chat-bridge` agent with restricted permissions:
- No file reading
- No command execution  
- Only safe MCP tools (time, weather, web-search)

### Rate Limiting

Built-in rate limiting prevents spam (5 second cooldown per user).

## Running as a Service

Create a systemd service for persistent operation:

### `/etc/systemd/system/opencode-matrix.service`

```ini
[Unit]
Description=OpenCode Matrix Bridge
After=network.target

[Service]
Type=simple
User=youruser
Group=youruser
WorkingDirectory=/home/youruser/opencode-chat-bridge
Environment=PATH=/home/youruser/.bun/bin:/home/youruser/.opencode/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/youruser
ExecStart=/home/youruser/.bun/bin/bun connectors/matrix.ts
Restart=always
RestartSec=10

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=opencode-matrix

[Install]
WantedBy=multi-user.target
```

**Note:** Adjust paths for your bun and opencode installations.

### Start the Service

```bash
sudo systemctl daemon-reload
sudo systemctl enable opencode-matrix
sudo systemctl start opencode-matrix

# Check status
sudo systemctl status opencode-matrix

# View logs
journalctl -u opencode-matrix -f
```

## Troubleshooting

### Bot Not Responding

1. Check bot is in the room (look for join message in logs)
2. Check trigger pattern matches (`!oc ` or `@mention`)
3. Test OpenCode directly: `bun src/cli.ts "test"`
4. Check Matrix credentials are valid

### "Access token invalid"

Tokens can expire or be revoked:
1. Log back into Element with bot account
2. Get new access token from Help & About
3. Update `.env`
4. Restart the connector

### Bot Doesn't Join Room

1. Make sure the room is not encrypted, or bot has been verified
2. Check the invite was sent to correct user ID
3. Look for errors in connector logs

### Images Not Uploading

1. Check the document library MCP server is running
2. Verify the image file exists in the cache directory
3. Look for upload errors in logs

## Next Steps

- Review [Security documentation](SECURITY.md) for permission details
- See [Architecture](ARCHITECTURE.md) for system design
- Check [Contributing](CONTRIBUTING.md) to help improve the connector
