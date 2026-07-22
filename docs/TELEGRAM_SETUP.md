# Telegram Setup Guide

This guide walks you through setting up the Telegram connector for OpenCode Chat Bridge.

## Overview

The Telegram connector uses the public Telegram Bot API (HTTP) via long-polling
(`getUpdates`). It does **not** require a public webhook or any incoming ports,
so it works behind NAT, corporate firewalls, and on machines without a
TLS-terminated domain.

**How it works:**
1. You create a bot via [@BotFather](https://t.me/BotFather) on Telegram
2. You copy the bot token into your `.env` file
3. The connector authenticates with `getMe`, then long-polls `getUpdates` for
   incoming messages
4. For each matching message, an isolated OpenCode session is created
   (per chat, or per forum topic) and the response is streamed back to the
   same chat

The connector has **zero external runtime dependencies** -- it uses the native
`fetch` API.

## Step 1: Create the Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts (give it a name and a unique
   username ending in `bot`)
3. BotFather replies with an HTTP API token like
   `110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`. Copy it.

Optionally, send `/setprivacy` to BotFather and choose **Disable** so the bot
can read all group messages (not just commands and mentions). This is required
for the connector's per-topic follow-up behavior to work without re-mentioning
the bot. The connector still respects `TELEGRAM_ALLOWED_USERS` and the
`ignoreUsers` allowlist either way.

## Step 2: Configure Environment

Add to your `.env` file:

```bash
TELEGRAM_BOT_TOKEN=110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw

# Optional: restrict to specific user IDs (comma-separated)
# Find a user's ID by messaging them and checking @userinfobot or similar
TELEGRAM_ALLOWED_USERS=123456789,987654321

# Optional: drop messages that arrived while the bot was offline
# (default: process backlog once on startup)
# TELEGRAM_DROP_PENDING=1
```

If you prefer config-file-based setup (recommended for self-hosted
installations), add to `chat-bridge.json`:

```json
{
  "telegram": {
    "enabled": true,
    "token": "{env:TELEGRAM_BOT_TOKEN}",
    "respondToMentions": true,
    "threadIsolation": true,
    "respondToReplies": true,
    "attachments": {
      "enabled": true,
      "maxFileBytes": 20971520,
      "maxFilesPerMessage": 4
    },
    "ignoreChats": [],
    "ignoreUsers": [],
    "allowedUsers": []
  }
}
```

All keys are optional except `enabled` and `token`. `respondToMentions` (default
`true`) makes the bot also reply when you `@`-mention it in groups (in
addition to the trigger prefix). `threadIsolation` (default `true`) gives each
forum topic its own isolated OpenCode session. `respondToReplies` (default
`true`) makes the bot also reply when you swipe-reply to one of its own
messages, even without a trigger prefix; set it to `false` to disable.
`attachments.enabled` (default `true`) controls incoming file downloads;
`attachments.maxFileBytes` is capped at Telegram Bot API's 20 MB limit and
`attachments.maxFilesPerMessage` defaults to 4.

## Step 3: Run the Connector

```bash
bun connectors/telegram.ts
```

Expected output:

```
[TELEGRAM] Starting...
  Trigger: !oc
  Bot name: oc
  Session storage: ~/.cache/opencode-chat-bridge/sessions
  Thread isolation: on (per-topic sessions)
  Respond to mentions: on
[TELEGRAM] Cleaning up old sessions...
  Bot: @your_bot (id=1234567890)
  Webhook cleared
[TELEGRAM] Started! Listening for messages...
```

## Step 4: Test the Bot

Open a chat with your bot (in Telegram, search for the bot's @-username) and
type:

```
!oc hello
!oc what's the weather in Barcelona?
!oc /help
!oc /status
!oc /clear
```

In a group with **Topics enabled** (a Telegram supergroup converted to a
forum), open a topic and send `!oc hello` there. The bot replies inside that
topic; subsequent plain replies in the topic continue that conversation until
you send `/clear` or 30 minutes pass without activity.

In groups **without** topics, prefix every message with `!oc` or `@botname` to
trigger the bot.

## Behavior Reference

### Trigger prefix

Default trigger is `!oc`. Override per-connector via `TELEGRAM_TRIGGER` or
globally via `TRIGGER` in `chat-bridge.json`.

A message becomes a query when:

1. It starts with `${TRIGGER}` (e.g., `!oc summarize this`), or
2. It `@`-mentions the bot (e.g., `@your_bot hello`), or
3. It is sent to the bot in a private chat (auto-handled, no prefix needed), or
4. It is a plain reply inside an active topic when `threadIsolation` is on
   (the connector continues the conversation without re-mentioning), or
5. It is a swipe-reply to one of this bot's own messages, when
   `respondToReplies` is on (default `true`). This makes the bot answer when
   you long-press its message and tap "Reply", even in a regular group with
   no topic and no trigger. In groups the connector requires an active session
   for the chat first, so it doesn't pick up stale replies to week-old bot
   messages. The match is keyed on the parent message's `from.id`, so replies
   to other bots (or to messages where Telegram redacts `from`) are ignored.

### Commands

| Command | Description |
|---------|-------------|
| `!oc /status` | Show session info |
| `!oc /clear` (or `/reset`) | Reset conversation session |
| `!oc /help` | Show available commands |

OpenCode-native commands (`/init`, `/compact`, `/review`, ...) are discovered
via ACP and listed in `/help`. When invoked they are forwarded directly to
OpenCode.

### Per-topic vs per-chat sessions

Telegram supergroups can be converted into **forums** with topics. Each topic
is an independent sub-chat identified by `message_thread_id`.

- `threadIsolation: true` (default): sessions are keyed on
  `${chatId}:${messageThreadId}`. Each topic has its own conversation history.
- `threadIsolation: false`: one session per `chatId`. All topics in the
  supergroup share conversation history.

In both cases, **replies are always posted inside the topic the user wrote
from** (using `message_thread_id`). `threadIsolation` only controls SESSION
keying -- reply routing is independent, because Telegram users expect the
bot's response where they asked. Without this, replies in a topic would land
in the supergroup's general chat root and be invisible to anyone navigating
the forum.

### File uploads

When OpenCode produces images or documents, the connector uploads them as
native Telegram attachments via `sendPhoto` and `sendDocument`. Files produced
during tool use (e.g., `bash` outputs, `[DOCLIBRARY_IMAGE]` /
`[DOCLIBRARY_DOC]` markers) are sent automatically.

Telegram limits: photos up to **10 MB** and 1024x1024 max dimension before
recomputation; documents up to **50 MB**.

### File attachments from users

Users can send the bot photos, documents, videos, audio files, voice notes,
animations (GIFs), video notes, and stickers. The connector downloads each
attachment to `<session-cwd>/uploads/` and surfaces its absolute path to the
LLM alongside the message caption, so:

- **Photo with caption `What's in this picture?`** -> the LLM sees
  `[Attached file: /path/to/uploads/...jpg (image/jpeg, N bytes, photo,
  filename="...")]` followed by your caption, and can use `read`, `bash`,
  `glob`, etc. to inspect it.
- **Document with caption `Summarise this paper`** -> same pattern; the LLM
  reads the file directly.
- **Caption-less attachment in a DM** -> the bot still triggers because the
  presence of an attachment counts as engagement. In groups the trigger
  requirement still applies unless the message is inside an active topic or is
  a reply to this bot in an active session.
- **Voice / video / animation** -> downloaded with default MIME types; the LLM
  treats them as opaque file paths for whatever tool you have configured
  (e.g., a transcription MCP server).

Telegram Bot API caps downloads at **20 MB per file**. Files above that size
are skipped with a log line and the message is still processed (with whatever
caption the user sent). The connector also enforces `attachments.maxFileBytes`
(up to the Telegram cap) and `attachments.maxFilesPerMessage` (default 4).
Each session cleans up its `uploads/` directory when the session itself is
removed (`SESSION_RETENTION_DAYS`, default 7).

### Long message splitting

The Telegram Bot API caps `sendMessage` at **4096 characters**. The connector
splits longer responses at newline boundaries and sends them as sequential
messages. The first chunk keeps the `reply_to_message_id` reference (in groups)
or the `message_thread_id` reference (in topics).

### Backlog handling

By default, when the connector starts it processes every message Telegram has
queued since the last `getUpdates` call. If you'd rather only see new
messages, set `TELEGRAM_DROP_PENDING=1` (or call `deleteWebhook` with
`drop_pending_updates=true` which the connector does on startup if this flag
is set). With the flag, the connector consumes one batch with `timeout=0` and
advances its offset to skip past the queue.

### Rate limiting

A 5-second per-user rate limit is enforced using the standard
`chat-bridge.json:rateLimitSeconds` setting. Configure via env
`RATE_LIMIT_SECONDS` or the existing global config.

### Privacy in groups

By default a Telegram bot only receives messages that either (a) start with
`/`, (b) mention the bot's @-username, or (c) are replies to the bot's own
messages. If you want the bot to react to every message in a group (e.g., for
the per-topic follow-up behavior), disable privacy via BotFather:

```
/setprivacy -> Disable
```

For private chats there is no such restriction.

## Running as a Service

### With nohup

```bash
nohup bun connectors/telegram.ts > logs/telegram.log 2>&1 &
```

### With systemd

Create `/etc/systemd/system/opencode-telegram.service`:

```ini
[Unit]
Description=OpenCode Telegram Bridge
After=network.target

[Service]
Type=simple
User=opencode
WorkingDirectory=/opt/opencode-chat-bridge
EnvironmentFile=/opt/opencode-chat-bridge/.env
Environment=OPENCODE_CONFIG=/opt/opencode-chat-bridge/opencode.json
ExecStart=/usr/local/bin/bun connectors/telegram.ts
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-telegram
```

### With Docker

```bash
docker compose up telegram
```

(`docker-compose.yml` ships with a pre-configured `telegram` service.)

## Troubleshooting

### "Error: TELEGRAM_BOT_TOKEN not set"

The connector can't find a token. Make sure `.env` exists in the directory
where you're running the connector, and that `TELEGRAM_BOT_TOKEN=...` is
uncommented. The token from BotFather looks like
`110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw` -- it should contain a colon.

### Bot never responds in a group

Two possible causes:

1. **Privacy mode is on.** In Telegram, message
   [@BotFather](https://t.me/BotFather) `/setprivacy` -> **Disable**.
2. **The chat is in the `ignoreChats` list, or the user is in the
   `ignoreUsers` / non-allowed list.** Check `chat-bridge.json` (or the
   `TELEGRAM_ALLOWED_USERS` env var) and the logs for `[IGNORED]`.

### Bot replies but says "I couldn't connect to the AI service"

The connector authenticated with Telegram successfully but can't reach
OpenCode. Make sure `OPENCODE_CONFIG` is set (if you customized the config
file), that `opencode` is on the path, and that OpenCode is authenticated
(`opencode auth status`).

### 429 Too Many Requests

The connector honors Telegram's `retry_after` parameter for 429 responses and
backs off accordingly. If you see repeated 429s, you're either polling too
aggressively (don't set `POLL_TIMEOUT_SECS` lower than 30) or running multiple
connectors against the same bot token (each `getUpdates` call consumes your
global rate limit).

### Session messages from stale topics

When `threadIsolation` is on, each forum topic gets its own session directory
under `~/.cache/opencode-chat-bridge/sessions/telegram/<chatId>:<threadId>/`.
On startup, sessions older than `SESSION_RETENTION_DAYS` (default 7) are
removed. To also expire inactive sessions at runtime, set
`SESSION_RETENTION_MINS=30`.

To inspect a session's directory while debugging:

```bash
ls ~/.cache/opencode-chat-bridge/sessions/telegram/
```

## Security Notes

- **Keep your bot token secret.** Anyone with the token can impersonate the
  bot. Don't commit `.env` -- it's already in `.gitignore`.
- **Use `TELEGRAM_ALLOWED_USERS` in production** unless you intend the bot to
  be world-usable. Without it, anyone who messages the bot can drive the
  connected OpenCode session.
- **Bot privacy settings in groups** are independent of the `ignoreUsers`
  list. Both apply.
- **Telegram bot messages are NOT end-to-end encrypted.** Conversations with
  bots are cloud chats stored on Telegram's servers. Anyone with access to
  those servers (including Telegram itself and bot developers) can read them.
  Never send sensitive data to a bot. See [Telegram Bot Message
  Privacy](SECURITY.md#telegram-bot-message-privacy) for details and
  sources.
- Review the [Security documentation](SECURITY.md) for the OpenCode
  permission model -- the connector enforces OpenCode's per-tool allowlist,
  not prompt-based restrictions.

## Architecture

```
Telegram Client App
    ↓ (HTTPS long-poll)
Telegram Bot API
    ↓
Telegram Connector (connectors/telegram.ts)
    ↓ (ACP Protocol)
OpenCode
    ↓
AI Response
    ↓
Telegram (via Bot API)
```

The connector maintains one ACP session per chat (or per topic with
`threadIsolation`), allowing conversation continuity.

## Limitations

- **No group admin actions.** The connector does not handle Telegram admin
  events like new members, left members, or pinned messages.
- **Stickers / voice / video messages** in the absence of a caption and the
  trigger/mention requirement are not forwarded to OpenCode. Captioned media
  of any kind is processed normally (see [File attachments from
  users](#file-attachments-from-users)).
- **Inline queries** are not handled. Trigger the bot by sending it a
  message directly.
- **One bot per connector instance.** Run multiple Telegram bots by
  starting additional connector processes with separate
  `TELEGRAM_BOT_TOKEN` env vars.
