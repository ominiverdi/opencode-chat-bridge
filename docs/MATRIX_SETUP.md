# Matrix Setup Guide

This guide walks through setting up the Matrix protocol for opencode-chat-bridge.

## Prerequisites

- A Matrix account for your bot
- Access to create access tokens
- (Optional) A Matrix homeserver you control

## Step 1: Create Bot Account

### Option A: matrix.org (Public)

1. Go to https://app.element.io
2. Click "Create Account"
3. Choose a username like `my-opencode-bot`
4. Complete registration

### Option B: Self-Hosted Homeserver

If you run your own Synapse/Dendrite server:

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

Create `chat-bridge.json`:

```json
{
  "matrix": {
    "enabled": true,
    "homeserver": "https://matrix.org",
    "userId": "@mybot:matrix.org",
    "accessToken": "{env:MATRIX_ACCESS_TOKEN}",
    "deviceId": "OPENCODE_BRIDGE"
  }
}
```

Set environment variable:

```bash
export MATRIX_ACCESS_TOKEN="syt_xxxxx..."
```

## Step 4: Invite Bot to Rooms

Before the bot can respond in a room, it must be a member.

### Manual Invite

In Element or your Matrix client:
1. Open the room
2. Click room settings → "People"
3. Invite `@mybot:matrix.org`

### Auto-Join on Invite

Enable in config:

```json
{
  "matrix": {
    "autoJoin": true
  }
}
```

## Trigger Patterns

Configure how users invoke the bot:

```json
{
  "matrix": {
    "triggerPatterns": [
      "@mybot:",
      "!oc ",
      "!ai "
    ]
  }
}
```

Examples that would trigger the bot:
- `@mybot: what is QGIS?`
- `!oc explain this code`
- `!ai search for Python tutorials`

## End-to-End Encryption (E2EE)

Matrix supports E2EE for private conversations. To enable:

```json
{
  "matrix": {
    "encryption": {
      "enabled": true,
      "storePath": "./matrix-store/"
    }
  }
}
```

### E2EE Requirements

1. **Persistent storage** - The `storePath` must persist across restarts
2. **Consistent deviceId** - Keep the same `deviceId` always
3. **Key verification** - Users may need to verify the bot's device

### E2EE Limitations

- First-time setup requires manual verification
- Key backup/recovery is complex
- Some features may not work in encrypted rooms

**Recommendation:** For public/semi-public bots, consider using unencrypted rooms to avoid complexity.

## Room Filtering

### Ignore Specific Rooms

```json
{
  "matrix": {
    "ignoreRooms": [
      "!abc123:matrix.org",
      "!spam-room:example.com"
    ]
  }
}
```

### Ignore Specific Users

```json
{
  "matrix": {
    "ignoreUsers": [
      "@spammer:example.com",
      "@test-account:matrix.org"
    ]
  }
}
```

## Rate Limiting

Matrix homeservers have rate limits. The bridge handles this gracefully, but you may see delays during high traffic.

**matrix.org limits:**
- ~10 requests per second
- Message sending may be throttled

**Self-hosted:** Configure in your homeserver settings.

## Troubleshooting

### "Unable to decrypt"

If users see encryption errors:
1. Ensure `encryption.enabled` is consistent
2. Verify `storePath` persists across restarts
3. Try re-verifying the bot's device
4. Consider using unencrypted rooms

### Bot Not Responding

1. Check bot is in the room: `!members` in Element
2. Verify trigger pattern matches your message
3. Check OpenCode logs for errors
4. Ensure access token is valid

### "Access token invalid"

Tokens can expire or be revoked:
1. Generate a new access token
2. Update environment variable
3. Restart OpenCode

### Connection Issues

```
Error: Failed to connect to homeserver
```

1. Verify homeserver URL is correct
2. Check network connectivity
3. Ensure homeserver is running
4. Try HTTPS if HTTP fails

## Security Best Practices

1. **Use environment variables** for tokens, never commit to git
2. **Use a dedicated account** for the bot
3. **Limit room access** - only join necessary rooms
4. **Monitor for abuse** - check logs regularly
5. **Consider unencrypted** for public bots to simplify security model

## Testing the Connection

After configuration, run OpenCode and check logs:

```bash
opencode

# Look for:
# [chat-bridge] Enabling Matrix protocol
# [matrix] Connected as @mybot:matrix.org
# [chat-bridge] Plugin initialized
```

Send a test message in a room where the bot is present:

```
@mybot: hello!
```

You should see the bot respond.
