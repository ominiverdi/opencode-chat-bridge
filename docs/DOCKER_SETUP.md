# Docker Setup

Run OpenCode Chat Bridge with Docker - no Bun or Node.js installation required.

**Note:** OpenCode is installed at container startup (not baked into the image), so you always get the latest version. First startup takes ~10 seconds longer. Use a persistent volume to avoid re-downloading on restart.

## Quick Start

```bash
# Pull the latest image
docker pull lbecchi/opencode-chat-bridge

# Run a connector (example: Discord)
docker run -d \
  --name opencode-discord \
  -e CONNECTOR=discord \
  -e DISCORD_TOKEN=your_bot_token \
  -v opencode-sessions:/data/sessions \
  lbecchi/opencode-chat-bridge
```

## Using Docker Compose (Recommended)

Docker Compose makes it easy to manage multiple connectors and persistent storage.

### 1. Clone and Configure

```bash
git clone https://github.com/ominiverdi/opencode-chat-bridge
cd opencode-chat-bridge
cp .env.example .env
```

### 2. Edit `.env` with Your Credentials

```bash
# Discord
DISCORD_TOKEN=your_discord_bot_token

# Slack
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token

# Matrix
MATRIX_HOMESERVER=https://matrix.org
MATRIX_USER_ID=@yourbot:matrix.org
MATRIX_PASSWORD=your_password

# Mattermost
MATTERMOST_URL=https://mattermost.example.com
MATTERMOST_TOKEN=your_bot_token
```

### 3. Run Connectors

```bash
# Run a single connector
docker-compose up discord

# Run multiple connectors
docker-compose up discord slack matrix

# Run in background
docker-compose up -d discord

# View logs
docker-compose logs -f discord

# Stop
docker-compose down
```

## Available Connectors

| Connector | Environment Variables |
|-----------|----------------------|
| `discord` | `DISCORD_TOKEN` |
| `slack` | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` |
| `matrix` | `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_PASSWORD` or `MATRIX_ACCESS_TOKEN` |
| `whatsapp` | (QR code auth - see below) |
| `mattermost` | `MATTERMOST_URL`, `MATTERMOST_TOKEN`, `MATTERMOST_TEAM` (optional) |

## WhatsApp Setup

WhatsApp requires QR code authentication on first run:

```bash
# Run interactively to scan QR code
docker-compose run --rm whatsapp

# After linking, run in background
docker-compose up -d whatsapp
```

The auth session is persisted in the `whatsapp-auth` volume.

## Configuration Files

The bot uses three configuration files. Mount them into the container:

```bash
docker run ... \
  -v /path/to/opencode.json:/app/opencode.json:ro \
  -v /path/to/chat-bridge.json:/app/chat-bridge.json:ro \
  -v /path/to/AGENTS.md:/app/AGENTS.md:ro \
  ...
```

### opencode.json

Model and AI provider configuration. See `opencode.example.json` for reference.

```json
{
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

### chat-bridge.json

Bot settings: trigger prefix, bot name, connector options. See `config.example.json` for reference.

```json
{
  "botName": "mybot",
  "trigger": "!bot",
  "matrix": {
    "enabled": true,
    "homeserver": "https://matrix.org",
    "userId": "{env:MATRIX_USER_ID}",
    "password": "{env:MATRIX_PASSWORD}"
  }
}
```

Environment variables are substituted using `{env:VAR_NAME}` syntax.

### AGENTS.md

System prompt and instructions for the AI. This file is copied to each session directory.

## AI Provider Configuration

Set your API key as an environment variable:

```bash
# Anthropic (Claude)
docker run ... -e ANTHROPIC_API_KEY=sk-ant-xxx ...

# OpenAI
docker run ... -e OPENAI_API_KEY=sk-xxx ...

# Google
docker run ... -e GOOGLE_API_KEY=xxx ...
```

For local LLM servers (llama.cpp, Ollama, etc.), use `--network=host` to access localhost.

## Persistent Storage

Docker volumes store runtime data:

- `sessions` - Conversation history for all connectors
- `whatsapp-auth` - WhatsApp authentication data
- `opencode` - OpenCode binary (optional, avoids re-download on restart)
- `opencode-data` - OpenCode database and settings

Recommended volume mounts:

```bash
docker run ... \
  -v opencode-sessions:/data/sessions \
  -v opencode-bin:/root/.opencode \
  -v opencode-data:/root/.local/share/opencode \
  ...
```

To clear sessions:

```bash
docker volume rm opencode-chat-bridge_sessions
```

## Building Locally

```bash
# Build the image
docker build -t opencode-chat-bridge .

# Run with local build
docker run -e CONNECTOR=discord -e DISCORD_TOKEN=... opencode-chat-bridge
```

## Image Tags

- `lbecchi/opencode-chat-bridge:latest` - Latest stable release
- `lbecchi/opencode-chat-bridge:main` - Latest main branch
- `lbecchi/opencode-chat-bridge:0.4.0` - Specific version

## Troubleshooting

### View Logs

```bash
docker-compose logs -f discord
docker logs opencode-discord
```

### Container Won't Start

Check environment variables are set:

```bash
docker-compose config
```

### Session Issues

Clear and restart:

```bash
docker-compose down
docker volume rm opencode-chat-bridge_sessions
docker-compose up -d discord
```
