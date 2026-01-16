# Contributing to opencode-chat-bridge

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) runtime
- Git
- A Matrix account for testing (optional)
- OpenCode installed

### Development Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/opencode-chat-bridge.git
cd opencode-chat-bridge

# Install dependencies
bun install

# Run in development mode
bun run dev
```

### Running with OpenCode

For integration testing:

```bash
# Terminal 1: Start OpenCode server
opencode serve --port 4097

# Terminal 2: Run the plugin in dev mode
bun run dev
```

## Project Structure

```
opencode-chat-bridge/
├── src/
│   ├── index.ts              # Plugin entry point
│   ├── bridge.ts             # Core bridge logic
│   ├── session-manager.ts    # Room→Session mapping
│   ├── protocols/
│   │   ├── base.ts           # Protocol interface
│   │   └── matrix/
│   │       ├── client.ts     # Matrix implementation
│   │       └── types.ts      # Matrix types
│   └── utils/
│       ├── config.ts         # Config utilities
│       └── logger.ts         # Logging
├── docs/                     # Documentation
├── config.example.json       # Example configuration
├── package.json
└── tsconfig.json
```

## Adding a New Protocol

We welcome contributions for new chat protocols! Here's how:

### 1. Create Protocol Directory

```bash
mkdir -p src/protocols/discord
touch src/protocols/discord/{client.ts,types.ts}
```

### 2. Define Types

```typescript
// src/protocols/discord/types.ts
import type { ProtocolConfig } from '../base'

export interface DiscordConfig extends ProtocolConfig {
  token: string
  // ... Discord-specific options
}
```

### 3. Implement ChatProtocol

```typescript
// src/protocols/discord/client.ts
import type { ChatProtocol, ChatMessage } from '../base'
import type { DiscordConfig } from './types'

export class DiscordProtocol implements ChatProtocol {
  readonly name = 'discord'
  // ... implement all methods
}
```

### 4. Register in Plugin

Update `src/index.ts` to initialize your protocol:

```typescript
if (config.discord?.enabled) {
  bridge.addProtocol(new DiscordProtocol(config.discord))
}
```

### 5. Add Documentation

Create `docs/<PROTOCOL>_SETUP.md` with setup instructions.

### 6. Add Example Config

Update `config.example.json` with your protocol's options.

## Code Style

### TypeScript

- Use strict TypeScript
- Prefer interfaces over types for object shapes
- Use explicit return types for public functions
- Document public APIs with JSDoc comments

### Naming Conventions

- `camelCase` for variables and functions
- `PascalCase` for classes and types
- `SCREAMING_SNAKE_CASE` for constants
- Descriptive names over abbreviations

### Error Handling

- Use typed errors where possible
- Log errors with context
- Gracefully handle recoverable errors
- Fail fast for unrecoverable errors

## Testing

### Unit Tests

```bash
bun test
```

### Manual Testing

1. Set up test Matrix account
2. Configure `chat-bridge.json` with test credentials
3. Run OpenCode with the plugin
4. Send test messages

### Test Checklist

- [ ] Message receiving works
- [ ] Message sending works
- [ ] Mode commands parse correctly
- [ ] Long messages split properly
- [ ] Typing indicators show/hide
- [ ] Session persistence works
- [ ] Error messages display correctly

## Pull Request Process

### Before Submitting

1. **Run type checking:** `bun run typecheck`
2. **Test your changes:** Manual and automated
3. **Update documentation:** If adding features
4. **Add to CHANGELOG:** Note your changes

### PR Requirements

- Clear title describing the change
- Description of what and why
- Reference any related issues
- Include test evidence if applicable

### PR Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
How was this tested?

## Checklist
- [ ] Types pass (`bun run typecheck`)
- [ ] Tests pass (`bun test`)
- [ ] Documentation updated
- [ ] CHANGELOG updated
```

## Reporting Issues

### Bug Reports

Include:
- OpenCode version
- Plugin version
- Protocol being used
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs

### Feature Requests

Include:
- Use case description
- Proposed solution (if any)
- Alternatives considered

## Community

### Getting Help

- Open a GitHub issue
- Join OpenCode Discord
- Check existing documentation

### Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Recognition

Contributors will be recognized in:
- CONTRIBUTORS.md file
- Release notes
- Project README (for significant contributions)

Thank you for contributing to opencode-chat-bridge!
