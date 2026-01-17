# Matrix Setup Guide

This guide walks through setting up Matrix for the opencode-chat-bridge.

## Prerequisites

- A Matrix account for your bot
- `bun` runtime installed
- OpenCode installed (`~/.opencode/bin/opencode`)

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

## Step 3: Configure the Bridge

### Create `.env` file

```bash
MATRIX_ACCESS_TOKEN="syt_xxxxx..."
```

### Update `standalone.ts`

Edit the configuration section:

```typescript
const MATRIX_HOMESERVER = 'https://matrix.org'
const MATRIX_USER_ID = '@my-opencode-bot:matrix.org'

// Customize trigger patterns
const TRIGGER_PATTERNS = ['@my-opencode-bot:', '!oc ']
```

## Step 4: Invite Bot to Rooms

The bot must be a member of any room where it should respond.

### Manual Invite

In Element or your Matrix client:
1. Open the room
2. Click room settings > "People"
3. Click "Invite"
4. Enter `@my-opencode-bot:matrix.org`
5. Send invite

### Create a Test Room

1. In Element, click "+" > "New Room"
2. Name it "OpenCode Test"
3. Make it **not encrypted** (easier for testing)
4. Invite your bot

## Step 5: Start the Bridge

### Terminal 1: Start OpenCode Server

```bash
cd ~/github/opencode-chat-bridge
opencode serve --port 4096
```

You should see:
```
Starting server on :4096
```

### Terminal 2: Start the Bridge

```bash
cd ~/github/opencode-chat-bridge
source .env
bun standalone.ts
```

You should see:
```
Connecting to OpenCode at http://127.0.0.1:4096...
OpenCode connected (0 existing sessions)
Connecting to Matrix as @my-opencode-bot:matrix.org...
Starting Matrix client...
Matrix sync complete, ready to receive messages!
Trigger patterns: @my-opencode-bot:, !oc 
Mode commands: !s, !d, !a, !p
Bridge running. Press Ctrl+C to stop.
```

## Step 6: Test It

In your Matrix room, send:

```
!oc Hello, what can you do?
```

The bot should respond within a few seconds.

## Trigger Patterns

The bot responds when messages contain:

| Pattern | Example |
|---------|---------|
| `@bot:` | `@my-opencode-bot: what is Python?` |
| `!oc ` | `!oc explain async/await` |

You can add more patterns in `standalone.ts`.

## Mode Commands

After the trigger, you can specify a mode:

| Mode | Usage | Description |
|------|-------|-------------|
| `!s` | `!oc !s question` | Serious/helpful mode |
| `!d` | `!oc !d question` | Sarcastic/witty mode |
| `!a` | `!oc !a topic` | Agent research mode |
| `!p` | `!oc !p task` | Planning mode |

Example:
```
!oc !a research the history of QGIS
```

## Troubleshooting

### Bot Not Responding

1. **Check bot is in the room**
   - In Element, open room > People
   - Bot should be listed

2. **Check trigger pattern**
   - Must match exactly
   - Try: `!oc hello`

3. **Check logs**
   - Look at Terminal 2 for errors
   - Look for "Message from" log lines

4. **Check OpenCode server**
   - Is Terminal 1 running?
   - Try: `curl http://127.0.0.1:4096/session`

### "Access token invalid"

Tokens can expire or be revoked:
1. Log back into Element with bot account
2. Go to Settings > Help & About
3. Get new access token
4. Update `.env`
5. Restart the bridge

### Connection Errors

```
Error: Failed to connect to homeserver
```

1. Verify homeserver URL is correct
2. Check internet connectivity
3. Ensure matrix.org is not down
4. Try HTTPS if HTTP fails

### "Unable to decrypt"

If you're in an encrypted room:
1. E2EE is not fully supported in standalone mode
2. Create a new **unencrypted** room for testing
3. Or use the full plugin approach (if/when it works)

## Running as a Service

For production, create a systemd service:

### `/etc/systemd/system/opencode-bridge.service`

```ini
[Unit]
Description=OpenCode Chat Bridge
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/opencode-chat-bridge
EnvironmentFile=/home/youruser/opencode-chat-bridge/.env
ExecStart=/usr/bin/bun standalone.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Don't forget to also run `opencode serve` as a service.

### Start the Service

```bash
sudo systemctl daemon-reload
sudo systemctl enable opencode-bridge
sudo systemctl start opencode-bridge

# Check status
sudo systemctl status opencode-bridge

# View logs
journalctl -u opencode-bridge -f
```

## Security Best Practices

1. **Use environment variables** - Never commit tokens to git
2. **Use a dedicated account** - Don't use personal Matrix accounts
3. **Limit room access** - Only join rooms you control
4. **Monitor logs** - Watch for abuse patterns
5. **Use unencrypted rooms** - Simpler security model for bots

## Next Steps

Once basic setup works:
1. Customize trigger patterns for your use case
2. Define custom agents in `opencode.json`
3. Add MCP servers for custom tools
4. Consider session persistence for production
