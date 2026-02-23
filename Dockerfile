# OpenCode Chat Bridge
# Multi-platform chat bridge for OpenCode AI
# Using Debian-based image for glibc (required by Matrix crypto)
FROM oven/bun:1-debian

LABEL org.opencontainers.image.source="https://github.com/ominiverdi/opencode-chat-bridge"
LABEL org.opencontainers.image.description="Bridge OpenCode AI to chat platforms (Discord, Slack, Matrix, WhatsApp)"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Install curl (OpenCode installed at runtime via entrypoint)
RUN apt-get update && apt-get install -y curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install dependencies first (cached layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile && \
    cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs && \
    node download-lib.js

# Copy source files
COPY src/ ./src/
COPY connectors/ ./connectors/
COPY tsconfig.json ./

# Create directories for runtime data
RUN mkdir -p /data/sessions /data/whatsapp-auth

# Environment variables with defaults
ENV SESSION_BASE_DIR=/data/sessions
ENV WHATSAPP_AUTH_DIR=/data/whatsapp-auth

# Connector to run (discord, slack, matrix, whatsapp, mattermost)
ENV CONNECTOR=matrix

# Entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
