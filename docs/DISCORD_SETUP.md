# Discord Setup Guide

## Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name
3. Go to **Bot** in the left sidebar
4. Click **Reset Token** and copy the token (starts with `MTI...`)
5. Save it as `DISCORD_BOT_TOKEN` in your `.env` file

## Enable Required Intents

In the **Bot** settings, enable these **Privileged Gateway Intents**:
- **Message Content Intent** (required to read message content)

## Set Bot Permissions

Go to **OAuth2 > URL Generator**:

1. Select scopes: `bot`
2. Select permissions:
   - Send Messages
   - Read Message History
   - Attach Files (for image responses)

3. Copy the generated URL and open it to invite the bot to your server

## Configuration

Add to your `.env` file:

```bash
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_TRIGGER=!oc          # Optional, default: !oc
```

## Run

```bash
bun connectors/discord.ts
```

## Usage

In any channel where the bot has access:

```
!oc what time is it?
!oc search for opencode documentation
!oc /help
!oc /clear
```

## Troubleshooting

### Bot doesn't respond
- Check that **Message Content Intent** is enabled
- Verify the bot has permissions in the channel
- Check logs for errors

### "Missing Access" error
- Re-invite the bot with correct permissions
- Check channel-specific permission overwrites
