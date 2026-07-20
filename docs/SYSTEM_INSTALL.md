# System-Wide Installation

Install OpenCode Chat Bridge as a system service that starts automatically on boot. This guide covers manual installation on Linux with systemd, suitable for servers and persistent deployments.

For Docker-based deployment, see [Docker Setup](DOCKER_SETUP.md).

## Prerequisites

- Linux system with systemd
- [Bun](https://bun.sh) runtime (installed system-wide or per-user)
- [Node.js](https://nodejs.org) 22+ (required for Matrix E2EE native crypto bindings)
- [OpenCode](https://opencode.ai) CLI installed and authenticated
- Git

## 1. Create a System User

Create a dedicated unprivileged user to run the bridge:

```bash
sudo useradd -r -m -d /opt/opencode-chat-bridge -s /usr/sbin/nologin opencode-bridge
```

## 2. Install the Application

Clone and set up the project under `/opt`:

```bash
sudo git clone https://github.com/ominiverdi/opencode-chat-bridge /opt/opencode-chat-bridge
sudo chown -R opencode-bridge:opencode-bridge /opt/opencode-chat-bridge
```

Install dependencies as the bridge user:

```bash
sudo -u opencode-bridge -H bash -c '
  cd /opt/opencode-chat-bridge
  bun install
'
```

## 3. Install OpenCode

OpenCode must be available to the bridge user:

```bash
sudo -u opencode-bridge -H bash -c '
  curl -fsSL https://opencode.ai/install | bash
'
```

Verify:

```bash
sudo -u opencode-bridge -H bash -c '
  export PATH="$HOME/.opencode/bin:$PATH"
  opencode --version
'
```

## 4. Configure

### 4.1 Bridge Configuration

Create the bridge config file:

```bash
sudo -u opencode-bridge -H bash -c '
  cd /opt/opencode-chat-bridge
  cp chat-bridge.json.example chat-bridge.json
'
```

Edit `/opt/opencode-chat-bridge/chat-bridge.json` and enable the connectors you need by setting `"enabled": true` for each one.

### 4.2 Environment File

Create a systemd-compatible environment file (not `.env`, which is for shell use):

```bash
sudo tee /etc/opencode-chat-bridge.env > /dev/null << 'EOF'
# AI provider credentials
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Matrix connector
MATRIX_HOMESERVER=https://matrix.org
MATRIX_USER_ID=@yourbot:matrix.org
MATRIX_ACCESS_TOKEN=syt_your_token

# Slack connector
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_APP_TOKEN=xapp-your-token

# Discord connector
DISCORD_TOKEN=your_discord_token

# Telegram connector
TELEGRAM_BOT_TOKEN=your_telegram_token

# Mattermost connector
MATTERMOST_URL=https://mattermost.example.com
MATTERMOST_TOKEN=your_mattermost_token
EOF

sudo chmod 600 /etc/opencode-chat-bridge.env
sudo chown opencode-bridge:opencode-bridge /etc/opencode-chat-bridge.env
```

### 4.3 OpenCode Permissions

Create `opencode.json` in the bridge directory to define the chat-bridge agent and its tool permissions:

```bash
sudo -u opencode-bridge -H bash -c '
  cd /opt/opencode-chat-bridge
  cp opencode.example.json opencode.json
'
```

Edit `/opt/opencode-chat-bridge/opencode.json` to set your model and permissions. A minimal example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "default_agent": "chat-bridge",
  "agent": {
    "chat-bridge": {
      "mode": "primary",
      "permission": {
        "read": "deny",
        "edit": "deny",
        "bash": "deny",
        "glob": "deny",
        "grep": "deny",
        "task": "deny",
        "question": "allow",
        "time_*": "allow",
        "weather_*": "allow",
        "web-search_*": "allow"
      }
    }
  }
}
```

## 5. Systemd Service Units

Create one service unit per connector. Each unit runs a single connector process.

### 5.1 Matrix

```bash
sudo tee /etc/systemd/system/opencode-matrix.service > /dev/null << 'UNIT'
[Unit]
Description=OpenCode Chat Bridge - Matrix
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=opencode-bridge
Group=opencode-bridge
WorkingDirectory=/opt/opencode-chat-bridge
EnvironmentFile=/etc/opencode-chat-bridge.env
Environment=OPENCODE_CONFIG=/opt/opencode-chat-bridge/opencode.json
ExecStart=/usr/local/bin/bun connectors/matrix.ts
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/opencode-chat-bridge/state /opt/opencode-chat-bridge/.opencode
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
```

### 5.2 Slack

```bash
sudo tee /etc/systemd/system/opencode-slack.service > /dev/null << 'UNIT'
[Unit]
Description=OpenCode Chat Bridge - Slack
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=opencode-bridge
Group=opencode-bridge
WorkingDirectory=/opt/opencode-chat-bridge
EnvironmentFile=/etc/opencode-chat-bridge.env
Environment=OPENCODE_CONFIG=/opt/opencode-chat-bridge/opencode.json
ExecStart=/usr/local/bin/bun connectors/slack.ts
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/opencode-chat-bridge/state /opt/opencode-chat-bridge/.opencode
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
```

### 5.3 Discord

```bash
sudo tee /etc/systemd/system/opencode-discord.service > /dev/null << 'UNIT'
[Unit]
Description=OpenCode Chat Bridge - Discord
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=opencode-bridge
Group=opencode-bridge
WorkingDirectory=/opt/opencode-chat-bridge
EnvironmentFile=/etc/opencode-chat-bridge.env
Environment=OPENCODE_CONFIG=/opt/opencode-chat-bridge/opencode.json
ExecStart=/usr/local/bin/bun connectors/discord.ts
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/opencode-chat-bridge/state /opt/opencode-chat-bridge/.opencode
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
```

### 5.4 Telegram

```bash
sudo tee /etc/systemd/system/opencode-telegram.service > /dev/null << 'UNIT'
[Unit]
Description=OpenCode Chat Bridge - Telegram
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=opencode-bridge
Group=opencode-bridge
WorkingDirectory=/opt/opencode-chat-bridge
EnvironmentFile=/etc/opencode-chat-bridge.env
Environment=OPENCODE_CONFIG=/opt/opencode-chat-bridge/opencode.json
ExecStart=/usr/local/bin/bun connectors/telegram.ts
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/opencode-chat-bridge/state /opt/opencode-chat-bridge/.opencode
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
```

### 5.5 Mattermost

```bash
sudo tee /etc/systemd/system/opencode-mattermost.service > /dev/null << 'UNIT'
[Unit]
Description=OpenCode Chat Bridge - Mattermost
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=opencode-bridge
Group=opencode-bridge
WorkingDirectory=/opt/opencode-chat-bridge
EnvironmentFile=/etc/opencode-chat-bridge.env
Environment=OPENCODE_CONFIG=/opt/opencode-chat-bridge/opencode.json
ExecStart=/usr/local/bin/bun connectors/mattermost.ts
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/opencode-chat-bridge/state /opt/opencode-chat-bridge/.opencode
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
```

### 5.6 WhatsApp

WhatsApp requires QR code authentication on first run. Temporarily run interactively:

```bash
sudo -u opencode-bridge -H bash -c '
  cd /opt/opencode-chat-bridge
  export PATH="$HOME/.opencode/bin:$PATH"
  export $(grep -v "^#" /etc/opencode-chat-bridge.env | xargs)
  export OPENCODE_CONFIG=/opt/opencode-chat-bridge/opencode.json
  bun connectors/whatsapp.ts
'
```

Scan the QR code displayed in the terminal. After linking, create the service:

```bash
sudo tee /etc/systemd/system/opencode-whatsapp.service > /dev/null << 'UNIT'
[Unit]
Description=OpenCode Chat Bridge - WhatsApp
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=opencode-bridge
Group=opencode-bridge
WorkingDirectory=/opt/opencode-chat-bridge
EnvironmentFile=/etc/opencode-chat-bridge.env
Environment=OPENCODE_CONFIG=/opt/opencode-chat-bridge/opencode.json
Environment=WHATSAPP_AUTH_DIR=/opt/opencode-chat-bridge/.whatsapp-auth
ExecStart=/usr/local/bin/bun connectors/whatsapp.ts
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/opencode-chat-bridge/state /opt/opencode-chat-bridge/.opencode /opt/opencode-chat-bridge/.whatsapp-auth
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
```

### 5.7 Web

```bash
sudo tee /etc/systemd/system/opencode-web.service > /dev/null << 'UNIT'
[Unit]
Description=OpenCode Chat Bridge - Web Widget
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=opencode-bridge
Group=opencode-bridge
WorkingDirectory=/opt/opencode-chat-bridge
EnvironmentFile=/etc/opencode-chat-bridge.env
Environment=OPENCODE_CONFIG=/opt/opencode-chat-bridge/opencode.json
ExecStart=/usr/local/bin/bun connectors/web.ts
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/opencode-chat-bridge/state /opt/opencode-chat-bridge/.opencode
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
```

## 6. Enable and Start

Reload systemd and enable the connectors you configured:

```bash
sudo systemctl daemon-reload

# Enable and start individual connectors
sudo systemctl enable --now opencode-matrix
sudo systemctl enable --now opencode-slack
sudo systemctl enable --now opencode-discord
# ... etc.
```

Or enable a specific subset:

```bash
sudo systemctl enable --now opencode-matrix opencode-telegram
```

## 7. Managing Services

### Check Status

```bash
sudo systemctl status opencode-matrix
sudo systemctl status opencode-slack
```

### View Logs

```bash
# Follow logs for a connector
sudo journalctl -u opencode-matrix -f

# View recent logs
sudo journalctl -u opencode-matrix -n 50

# View logs from all connectors
sudo journalctl -u 'opencode-*' -f
```

### Restart After Config Changes

```bash
sudo systemctl restart opencode-matrix
```

### Stop a Connector

```bash
sudo systemctl stop opencode-slack
sudo systemctl disable opencode-slack
```

### Update the Application

```bash
sudo -u opencode-bridge -H bash -c '
  cd /opt/opencode-chat-bridge
  git pull
  bun install
'

# Restart affected connectors
sudo systemctl restart opencode-matrix opencode-slack
```

## Directory Layout

After installation the file tree looks like this:

```
/opt/opencode-chat-bridge/          # Application code (git clone)
  connectors/                       # Connector entry points
  src/                              # Core library
  chat-bridge.json                  # Bridge connector config
  opencode.json                     # OpenCode agent/permissions
  state/                            # Session store (created at runtime)
  .opencode/                        # OpenCode working data
  .whatsapp-auth/                   # WhatsApp session (if used)

/etc/opencode-chat-bridge.env       # Secrets and environment variables
/etc/systemd/system/opencode-*.service  # Systemd units
```

## Security Notes

- The environment file `/etc/opencode-chat-bridge.env` contains API keys and tokens. It is mode `600` and owned by the bridge user.
- The systemd units run with `NoNewPrivileges`, `ProtectSystem=strict`, and `ProtectHome=read-only`. Only the application directory and state paths are writable.
- The bridge user has no login shell (`/usr/sbin/nologin`) and cannot be used for SSH.
- Do not store API keys in `chat-bridge.json` or `opencode.json`. Use the environment file and `{env:VAR_NAME}` substitution syntax.

## Troubleshooting

### Service Fails to Start

Check the logs for the specific error:

```bash
sudo journalctl -u opencode-matrix -n 100 --no-pager
```

Common causes:

- Bun not found at `/usr/local/bin/bun` -- adjust `ExecStart` to match your install path (`which bun` to find it)
- OpenCode not installed for the bridge user -- run the OpenCode install step as the bridge user
- Missing or incorrect environment variables -- verify `/etc/opencode-chat-bridge.env`
- Permission denied on state directories -- check ownership of `/opt/opencode-chat-bridge/state`

### Matrix E2EE Fails

Ensure Node.js 22+ is installed and the Matrix crypto native bindings are downloaded:

```bash
sudo -u opencode-bridge -H bash -c '
  cd /opt/opencode-chat-bridge
  node -e "require(\"@matrix-org/matrix-sdk-crypto-nodejs\")"
'
```

If this fails, re-run the crypto download:

```bash
sudo -u opencode-bridge -H bash -c '
  cd /opt/opencode-chat-bridge/node_modules/@matrix-org/matrix-sdk-crypto-nodejs
  node download-lib.js
'
```

### WhatsApp QR Code Expired

WhatsApp auth sessions can expire. Stop the service, remove the auth data, and re-link:

```bash
sudo systemctl stop opencode-whatsapp
sudo -u opencode-bridge -H bash -c '
  rm -rf /opt/opencode-chat-bridge/.whatsapp-auth/*
'
# Then run interactively to scan the QR code again (see section 5.6)
```
