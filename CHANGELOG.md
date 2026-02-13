# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-02-13

### Added
- **E2EE support for Matrix** - Bot now works in encrypted rooms
- Native Rust crypto via `matrix-bot-sdk` with SQLite key persistence
- Password-based login with automatic token caching

### Changed
- **Replaced `matrix-js-sdk` with `matrix-bot-sdk`** - cleaner API, built-in E2EE
- Removed `indexeddbshim` and `@matrix-org/matrix-sdk-crypto-wasm` dependencies
- Simplified Matrix connector code (~40% smaller)
- Requires Node.js 22+ (for native crypto bindings)

### Fixed
- E2EE key persistence across restarts (was in-memory only)
- Crypto storage now uses native SQLite instead of IndexedDB polyfills

### Notes
- "Unverified device" warning is cosmetic - E2EE works correctly
- Cross-signing requires manual verification from Element (UIA limitation)
- Back up `~/.local/share/opencode-matrix-bot/` for crypto key persistence

## [0.3.0] - 2026-02-01

### Added
- **WhatsApp connector** using Baileys (QR code pairing)
- **BaseConnector** abstract class for connector development
- `SessionManager`, `RateLimiter`, `CommandHandler` utility classes
- Auto-copy of `opencode.json` to session directories for security
- Token usage estimates in `/status` command

### Changed
- Refactored all connectors to extend `BaseConnector` (~17% code reduction)
- Session storage moved to `~/.cache/opencode-chat-bridge/sessions/` (outside git repo)
- Improved `/status` output (removed directory path, added token estimates)
- Documentation now uses generic MCP examples (time, weather, web-search)

### Fixed
- **Security: Added `write` tool to deny list** - was missing and allowed file creation
- Config now properly applied to all sessions via `copyOpenCodeConfig()`

### Security
- `write` tool now explicitly denied in chat-bridge agent
- Session directories now receive `opencode.json` with permissions

## [0.2.0] - 2026-01-31

### Added
- **Slack connector** with Socket Mode support
- **Matrix connector** with image upload support
- Document library image handling via `[DOCLIBRARY_IMAGE]` markers
- Activity logging showing tool calls in chat (e.g., `> Getting time [time_get_current_time]`)
- Session management commands: `/status`, `/clear`, `/help`
- Rate limiting per user
- Per-room/channel session isolation

### Changed
- Refactored to ACP-based architecture
- Improved security model with permission-based tool restrictions
- Better error handling in connectors

### Fixed
- Regex pattern for image path detection
- Session cleanup on connector shutdown

## [0.1.0] - 2026-01-16

### Added
- Initial ACP client implementation
- Interactive CLI with streaming responses
- Skills system for custom bot personalities
- Basic security model with `opencode.json` permissions
- Project structure and documentation

### Security
- Permission-based tool restrictions (deny by default)
- Filesystem tools blocked for chat-bridge agent
- Tested against prompt injection attacks
