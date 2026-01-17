#!/bin/bash
# Start the OpenCode chat bridge
# Runs both the OpenCode server and the Matrix bridge

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Use local config (overrides global for permissions/agents)
export OPENCODE_CONFIG="$SCRIPT_DIR/opencode.json"

echo "Starting OpenCode Chat Bridge..."
echo "Config: $OPENCODE_CONFIG"
echo "Matrix user: @llm-assitant:matrix.org"
echo "Test room: #osgeo-bot:matrix.org"
echo ""

# Check if server is already running
if curl -s http://127.0.0.1:4096/session > /dev/null 2>&1; then
    echo "OpenCode server already running on port 4096"
else
    echo "Starting OpenCode server..."
    /home/ominiverdi/.opencode/bin/opencode serve --port 4096 &
    sleep 3
fi

# Start the bridge
echo "Starting Matrix bridge..."
exec bun standalone.ts
