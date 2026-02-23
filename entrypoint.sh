#!/bin/sh
set -e

case "$CONNECTOR" in
  discord)
    exec bun connectors/discord.ts
    ;;
  slack)
    exec bun connectors/slack.ts
    ;;
  matrix)
    exec bun connectors/matrix.ts
    ;;
  whatsapp)
    exec bun connectors/whatsapp.ts
    ;;
  mattermost)
    exec bun connectors/mattermost.ts
    ;;
  *)
    echo "Unknown connector: $CONNECTOR"
    echo "Valid options: discord, slack, matrix, whatsapp, mattermost"
    exit 1
    ;;
esac
