# Matrix Setup Guide

This guide walks through setting up Matrix for a future Matrix connector using opencode-chat-bridge.

> **Note:** The Matrix connector is planned but not yet implemented. This guide provides the foundation for when it's built.

## Prerequisites

- A Matrix account for your bot
- `bun` runtime installed
- OpenCode installed (`opencode --version`)

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

## Step 3: Store Credentials

Create `.env` file:

```bash
MATRIX_ACCESS_TOKEN="syt_xxxxx..."
MATRIX_HOMESERVER="https://matrix.org"
MATRIX_USER_ID="@my-opencode-bot:matrix.org"
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

## Future: Matrix Connector Architecture

When the Matrix connector is built, it will use the ACPClient:

```typescript
import { ACPClient } from "../src"
import { MatrixClient } from "matrix-js-sdk"

class MatrixConnector {
  private acp: ACPClient
  private matrix: MatrixClient
  
  async start() {
    // Connect to OpenCode via ACP
    this.acp = new ACPClient({ cwd: process.cwd() })
    await this.acp.connect()
    await this.acp.createSession()
    
    // Connect to Matrix
    this.matrix = MatrixClient.create({
      baseUrl: process.env.MATRIX_HOMESERVER,
      accessToken: process.env.MATRIX_ACCESS_TOKEN,
      userId: process.env.MATRIX_USER_ID,
    })
    
    // Handle messages
    this.matrix.on("Room.timeline", this.handleMessage.bind(this))
    await this.matrix.startClient()
  }
  
  async handleMessage(event) {
    if (event.getType() !== "m.room.message") return
    if (event.getSender() === this.matrix.getUserId()) return
    
    const text = event.getContent().body
    if (!this.shouldRespond(text)) return
    
    // Stream response to Matrix
    let buffer = ""
    this.acp.on("chunk", (chunk) => {
      buffer += chunk
      if (buffer.length > 500 || buffer.endsWith(".")) {
        this.matrix.sendMessage(event.getRoomId(), buffer)
        buffer = ""
      }
    })
    
    await this.acp.prompt(text)
    if (buffer) this.matrix.sendMessage(event.getRoomId(), buffer)
  }
  
  shouldRespond(text: string): boolean {
    return text.includes("@my-opencode-bot:") || text.startsWith("!oc ")
  }
}
```

## Trigger Patterns

Common patterns for bot invocation:

| Pattern | Example |
|---------|---------|
| `@bot:` | `@my-opencode-bot: what is Python?` |
| `!oc ` | `!oc explain async/await` |

## Security Considerations

### Use Unencrypted Rooms

E2EE (end-to-end encryption) requires additional setup:
- Device verification
- Key storage
- Cross-signing

For simplicity, start with unencrypted rooms.

### Permission Isolation

The bot uses the `chat-bridge` agent with restricted permissions:
- No file reading
- No command execution
- Only safe MCP tools

### Rate Limiting

Implement per-user rate limiting:

```typescript
const userLimits = new Map<string, number>()

function canRespond(userId: string): boolean {
  const now = Date.now()
  const last = userLimits.get(userId) || 0
  if (now - last < 5000) return false  // 5 second cooldown
  userLimits.set(userId, now)
  return true
}
```

## Running as a Service

When the connector is ready, create a systemd service:

### `/etc/systemd/system/opencode-matrix.service`

```ini
[Unit]
Description=OpenCode Matrix Bridge
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/opencode-chat-bridge
EnvironmentFile=/home/youruser/opencode-chat-bridge/.env
ExecStart=/usr/bin/bun connectors/matrix.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

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

1. Check bot is in the room
2. Check trigger pattern matches
3. Check OpenCode is working: `bun src/cli.ts "test"`
4. Check Matrix credentials are valid

### "Access token invalid"

Tokens can expire or be revoked:
1. Log back into Element with bot account
2. Get new access token
3. Update `.env`
4. Restart the connector

### Connection Errors

1. Verify homeserver URL is correct
2. Check internet connectivity
3. Ensure matrix.org is not down
4. Try HTTPS if HTTP fails

## Next Steps

When the Matrix connector is built:
1. Clone the repository
2. Configure `.env` with Matrix credentials
3. Run `bun connectors/matrix.ts`
4. Invite bot to rooms
5. Start chatting!

See [ARCHITECTURE.md](ARCHITECTURE.md) for connector design patterns.
