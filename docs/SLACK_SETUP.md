# Slack Setup Guide

This guide walks you through creating a Slack app and configuring the OpenCode Chat Bridge connector.

## Overview

The Slack connector uses **Socket Mode** which allows real-time messaging without needing a public server or webhook URL. This makes it ideal for running locally or behind a firewall.

## Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"**
3. Choose **"From scratch"**
4. Enter an App Name (e.g., "oc-bot" or "OpenCode Bot")
5. Select your workspace
6. Click **"Create App"**

## Step 2: Configure Bot Permissions

1. In the left sidebar, click **"OAuth & Permissions"**
2. Scroll to **"Bot Token Scopes"**
3. Click **"Add an OAuth Scope"** and add these scopes:

| Scope | Purpose |
|-------|---------|
| `chat:write` | Send messages |
| `files:write` | Upload images |
| `channels:history` | Read messages in public channels |
| `channels:read` | View channel info |
| `app_mentions:read` | Respond when @mentioned |

Optional scopes for DM support:
- `im:history` - Read direct messages
- `im:write` - Send direct messages

## Step 3: Enable Socket Mode

1. In the left sidebar, click **"Socket Mode"**
2. Toggle **"Enable Socket Mode"** to ON
3. You'll be prompted to create an App-Level Token:
   - Name it (e.g., "socket-token")
   - Add scope: `connections:write`
   - Click **"Generate"**
4. **Copy the `xapp-...` token** - this is your `SLACK_APP_TOKEN`

## Step 4: Configure Event Subscriptions

1. In the left sidebar, click **"Event Subscriptions"**
2. Toggle **"Enable Events"** to ON
3. Expand **"Subscribe to bot events"**
4. Click **"Add Bot User Event"** and add:
   - `app_mention` - When users @mention your bot
   - `message.channels` - Messages in public channels

5. Click **"Save Changes"**

## Step 5: Install to Workspace

1. In the left sidebar, click **"Install App"** (or go to OAuth & Permissions)
2. Click **"Install to Workspace"**
3. Review permissions and click **"Allow"**
4. **Copy the "Bot User OAuth Token"** (`xoxb-...`) - this is your `SLACK_BOT_TOKEN`

## Step 6: Configure Environment

Add the tokens to your `.env` file:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here
```

## Step 7: Run the Connector

```bash
bun connectors/slack.ts
```

You should see:
```
Starting Slack connector...
  Trigger: !oc
Slack connector started! Listening for messages...
```

## Step 8: Invite Bot to a Channel

In Slack:
1. Go to any channel
2. Type `/invite @your-bot-name`
3. Or click channel settings > Integrations > Add apps

## Usage

Once the bot is in a channel:

```
!oc what time is it?
!oc search the web for climate change
!oc show me page 50 of usgs_snyder
```

Or mention the bot directly:
```
@oc-bot what's the weather like?
```

### Commands

| Command | Description |
|---------|-------------|
| `!oc /help` | Show available commands |
| `!oc /status` | Show session info |
| `!oc /clear` | Reset conversation session |

## Troubleshooting

### "Socket Mode is not turned on"

Go to api.slack.com/apps > Your App > Socket Mode and enable it.

### Bot doesn't respond

1. Check that the bot is invited to the channel
2. Verify Event Subscriptions are enabled with correct events
3. Check the connector logs for errors
4. Make sure both tokens are correct in `.env`

### "missing_scope" error

Go to OAuth & Permissions and add the missing scope, then reinstall the app.

### Messages not appearing

Make sure you've subscribed to `message.channels` in Event Subscriptions.

## Security Notes

- Keep your tokens secret - never commit `.env` to git
- The bot only has access to channels it's invited to
- Use a dedicated workspace for testing before deploying to production
- Review the [Security documentation](SECURITY.md) for permission model details
