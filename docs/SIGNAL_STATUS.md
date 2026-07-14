# Signal Status

Signal is not currently supported by opencode-chat-bridge.

## Summary

Signal does not provide an official bot API comparable to Telegram, Slack, Matrix, Discord, or Mattermost. A connector is technically possible through [`signal-cli`](https://github.com/AsamK/signal-cli), but that would rely on unofficial linked-device automation.

This is similar in spirit to the WhatsApp connector using Baileys: both are unofficial client integrations. The difference is operational complexity and maintenance surface. WhatsApp support already exists in-tree and works through a direct JavaScript library; Signal would require an external daemon and additional lifecycle/security handling.

## What works technically

`signal-cli` can run as a Signal client or linked device and exposes:

- command-line send/receive
- daemon mode
- JSON-RPC
- D-Bus
- HTTP/SSE event streaming in daemon mode

This is enough to build a connector.

## Why not supported yet

A Signal connector would add a separate unofficial stack:

- external `signal-cli` installation
- Java/runtime requirements
- linked-device or registered-number setup
- a long-running `signal-cli` daemon to supervise
- local Signal credentials and cryptographic keys that must be protected
- dependency on `signal-cli` tracking Signal server/protocol changes
- SSE reconnect and daemon health monitoring
- self-chat/Note-to-Self echo-loop prevention
- phone-number redaction in logs
- extra work for groups, attachments, receipts, reactions, formatting, and rate limits

None of these are blockers individually, but together they make Signal a larger maintenance commitment than the currently supported connectors.

## If we revisit

A future Signal connector should:

- use `signal-cli` daemon/JSON-RPC rather than reimplementing the Signal protocol
- support linked-device mode
- default to explicit owner-only or allowlisted access
- redact phone numbers in logs
- track sent message timestamps to avoid Note-to-Self/self-echo loops
- document the operational and security tradeoffs clearly

## Current recommendation

Use Matrix, WhatsApp, Telegram, Slack, Discord, Mattermost, or Web for supported chat connectors.

For personal mobile control, the current recommended workflow is WhatsApp self-chat with:

```json
{
  "whatsapp": {
    "respondToOthers": false
  }
}
```

In that mode, plain self-chat messages act as prompts, other chats still require the configured trigger, and messages from other people are ignored.
