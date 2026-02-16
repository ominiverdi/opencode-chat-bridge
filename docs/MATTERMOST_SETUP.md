# Mattermost Setup Guide

## Create a Bot Account

1. Log in to your Mattermost server as an admin
2. Go to **Integrations > Bot Accounts** (not System Console)
3. Click **Add Bot Account**
4. Fill in:
   - **Username**: your bot name (e.g., `my-bot`)
   - **Display Name**: friendly name shown in conversations
   - **Description**: optional
   - **Role**: Member (sufficient for most use cases)
5. Copy the **Access Token** -- you will need it for configuration

## Add the Bot to a Team

Bots must be added to a team before they can see channels or receive messages.

1. Go to the team you want the bot to join
2. Open **Team Settings > Members** (or use the Mattermost CLI)
3. Add the bot user to the team

Alternatively, use the Mattermost API:

```bash
curl -X POST "https://mattermost.example.com/api/v4/teams/TEAM_ID/members" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"team_id": "TEAM_ID", "user_id": "BOT_USER_ID"}'
```

## Configuration

Add to your `.env` file:

```bash
MATTERMOST_URL=https://mattermost.example.com
MATTERMOST_TOKEN=your_bot_access_token
# MATTERMOST_TEAM=myteam   # Optional, auto-detected if bot is in one team
```

Or configure in `chat-bridge.json`:

```json
{
  "mattermost": {
    "enabled": true,
    "url": "{env:MATTERMOST_URL}",
    "token": "{env:MATTERMOST_TOKEN}",
    "teamName": "",
    "ignoreChannels": [],
    "ignoreUsers": []
  }
}
```

## Run

```bash
bun connectors/mattermost.ts
```

## Usage

In any channel where the bot is a member, use the trigger prefix:

```
!oc what time is it?
!oc who are you?
!oc /help
!oc /clear
```

You can also DM the bot directly -- no trigger prefix needed in DMs.

## How It Works

The connector uses the Mattermost REST API v4 and WebSocket for real-time events.
No external npm dependencies are required -- it uses native `fetch` and `WebSocket`
(built into Bun and Node.js 22+).

- **WebSocket**: connects to `wss://your-server/api/v4/websocket` for real-time message events
- **REST API**: used for sending messages, uploading files, and bot authentication
- **Reconnection**: automatic reconnect with exponential backoff (up to 10 attempts)
- **Keep-alive**: sends WebSocket pings every 30 seconds

## Features

- Trigger-based responses in channels
- Direct message support (no trigger needed)
- Image file uploads from tool results
- Long message splitting (Mattermost has a 16383 char limit)
- Tool output streaming
- Rate limiting per user

## Troubleshooting

### Bot doesn't respond

- Check that the bot is added to the team
- Verify the access token is correct
- Check logs for WebSocket connection errors
- Ensure the bot has permissions in the channel

### "Unauthorized" error

- Regenerate the bot access token in Integrations > Bot Accounts
- Make sure you are using the bot token, not a personal access token

### WebSocket disconnects

- The connector automatically reconnects with backoff
- Check server logs for rate limiting or connection issues
- Ensure the server allows WebSocket connections
