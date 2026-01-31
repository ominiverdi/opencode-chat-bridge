# WhatsApp Setup Guide

This guide walks you through setting up the WhatsApp connector for OpenCode Chat Bridge.

## Overview

The WhatsApp connector uses [Baileys](https://github.com/WhiskeySockets/Baileys), a WebSocket-based library that connects directly to WhatsApp's servers. No browser or Puppeteer is required.

**How it works:**
1. On first run, a QR code appears in your terminal
2. Scan it with WhatsApp (Settings > Linked Devices > Link a Device)
3. The session is saved locally for automatic reconnection

## Step 1: Install Dependencies

The connector uses these packages (already in package.json):

```bash
bun install
```

Key dependencies:
- `baileys` - WhatsApp Web API
- `qrcode-terminal` - Displays QR code in terminal

## Step 2: Configure Environment (Optional)

The WhatsApp connector works with minimal configuration. Optionally add to `.env`:

```bash
# Message prefix to trigger bot (default: !oc)
WHATSAPP_TRIGGER=!oc

# Restrict bot to specific phone numbers (comma-separated, optional)
# Leave empty to respond to everyone who messages
WHATSAPP_ALLOWED_NUMBERS=1234567890,0987654321
```

## Step 3: Run the Connector

```bash
bun connectors/whatsapp.ts
```

On first run, you'll see:

```
Starting WhatsApp connector...
  Trigger: !oc
  Bot name: OpenCode Bot
  Auth folder: /path/to/.whatsapp-auth
  Allowed numbers: ALL (no filter)

Scan this QR code with WhatsApp:
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
█ ▄▄▄▄▄ █ ▀▀██▀█ ▄▄▄▄▄ █
...
```

## Step 4: Link WhatsApp

1. Open WhatsApp on your phone
2. Go to **Settings** > **Linked Devices**
3. Tap **Link a Device**
4. Scan the QR code shown in the terminal

Once linked, you'll see:

```
WhatsApp connected!
Bot phone number: 1234567890
```

## Step 5: Test the Bot

Send a message to the linked WhatsApp number:

```
!oc hello
!oc what time is it?
!oc search for map projections
```

## Usage

### Trigger Prefix

Messages must start with the trigger (default: `!oc`):

```
!oc what time is it in Tokyo?
!oc search the web for climate change
!oc show me page 50 of usgs_snyder
```

### Commands

| Command | Description |
|---------|-------------|
| `!oc /help` | Show available commands |
| `!oc /status` | Show session info |
| `!oc /clear` | Reset conversation session |

### Restricting Access

To limit who can use the bot, set allowed phone numbers:

```bash
# .env
WHATSAPP_ALLOWED_NUMBERS=1234567890,0987654321
```

Numbers should be in international format without the `+` prefix.

## Session Persistence

The connector saves authentication data to `.whatsapp-auth/` directory. This allows automatic reconnection without scanning the QR code again.

**Important:** Keep this directory secure - it contains your WhatsApp session keys.

The `.whatsapp-auth/` directory is already in `.gitignore` to prevent accidental commits.

## Running as a Service

For production, run the connector in the background:

```bash
# Using nohup
nohup bun connectors/whatsapp.ts > logs/whatsapp.log 2>&1 &

# Or with systemd (create a service file)
# Or with pm2
pm2 start "bun connectors/whatsapp.ts" --name whatsapp-bot
```

## Troubleshooting

### QR Code Not Appearing

If the QR code doesn't display properly:
1. Make sure your terminal supports Unicode
2. Try a different terminal emulator
3. Check the logs for errors

### "Connection Closed" / Disconnected

WhatsApp may disconnect the session if:
- The phone's internet connection is unstable
- You manually unlink the device from WhatsApp
- The session token expires (rare)

To fix:
1. Delete the `.whatsapp-auth/` directory
2. Restart the connector
3. Scan the QR code again

### Bot Not Responding

1. Check that the connector is running and shows "WhatsApp connected!"
2. Verify the message starts with the trigger (`!oc`)
3. If using `WHATSAPP_ALLOWED_NUMBERS`, verify your number is in the list
4. Check the logs for errors

### Rate Limiting

The connector has built-in rate limiting (default: 5 seconds between messages per user). This prevents abuse and API throttling.

## Security Notes

- **Keep `.whatsapp-auth/` secure** - it contains session keys
- **Never commit `.whatsapp-auth/` to git** - it's in `.gitignore` by default
- Use `WHATSAPP_ALLOWED_NUMBERS` to restrict access in production
- The linked WhatsApp account should be a dedicated number, not your personal account
- Review the [Security documentation](SECURITY.md) for permission model details

## Limitations

- **No group support** - Currently responds only to direct messages
- **Text only input** - Voice messages and images from users are not processed
- **Single account** - One WhatsApp account per connector instance

## Architecture

```
WhatsApp App
    ↓ (WebSocket)
Baileys Library
    ↓
WhatsApp Connector (connectors/whatsapp.ts)
    ↓ (ACP Protocol)
OpenCode
    ↓
AI Response
    ↓
WhatsApp (via Baileys)
```

The connector maintains one ACP session per chat, allowing conversation continuity.
