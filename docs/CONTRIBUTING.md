# Contributing to opencode-chat-bridge

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) runtime
- Git
- OpenCode installed and authenticated

### Development Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/opencode-chat-bridge.git
cd opencode-chat-bridge

# Install dependencies
bun install

# Test the CLI
bun src/cli.ts "Hello, world!"
```

## Project Structure

```
opencode-chat-bridge/
├── src/
│   ├── acp-client.ts     # ACP protocol client (EventEmitter-based)
│   ├── cli.ts            # Interactive CLI
│   └── index.ts          # Library exports
├── connectors/           # Chat platform connectors
│   ├── matrix.ts
│   ├── slack.ts
│   └── whatsapp.ts
├── docs/                 # Documentation
├── opencode.json         # Agent and permission configuration
└── tests/                # Test scripts
```

## Contributing Areas

### 1. Chat Platform Connectors

We have connectors for several chat platforms, with more planned:

| Platform | Status | Priority |
|----------|--------|----------|
| Matrix | Done | - |
| Slack | Done | - |
| WhatsApp | Done | - |
| IRC | Planned | Low |
| Telegram | Planned | Low |

### 2. Documentation

- Improve existing docs
- Add examples
- Fix typos

## Adding a Chat Connector

### 1. Create Connector File

```bash
mkdir -p connectors
touch connectors/matrix.ts
```

### 2. Use ACPClient

```typescript
// connectors/matrix.ts
import { ACPClient } from "../src"

class MatrixConnector {
  private client: ACPClient
  
  constructor() {
    this.client = new ACPClient({ cwd: process.cwd() })
  }
  
  async start() {
    await this.client.connect()
    await this.client.createSession()
    
    // Set up event handlers
    this.client.on("chunk", (text) => {
      // Send to chat platform
    })
    
    this.client.on("tool", ({ name, status }) => {
      // Show tool usage
    })
  }
  
  async handleMessage(text: string) {
    await this.client.prompt(text)
  }
}
```

### 3. Handle Streaming

The ACPClient emits events for streaming responses:

```typescript
client.on("chunk", (text) => {
  // Buffer and send to chat
  buffer += text
  if (buffer.length > 500 || buffer.endsWith(".")) {
    sendToChat(buffer)
    buffer = ""
  }
})
```

### 4. Add Documentation

Create `docs/<PLATFORM>_SETUP.md` with:
- Prerequisites
- Configuration
- Quick start
- Troubleshooting

## Code Style

### TypeScript

- Use strict TypeScript
- Prefer interfaces over types for objects
- Use explicit return types for public functions
- Document public APIs with JSDoc

### Naming Conventions

- `camelCase` for variables and functions
- `PascalCase` for classes and types
- `SCREAMING_SNAKE_CASE` for constants
- Descriptive names over abbreviations

### Error Handling

- Use typed errors
- Log errors with context
- Handle recoverable errors gracefully
- Fail fast for unrecoverable errors

## Testing

### Manual Testing

```bash
# Test CLI
bun src/cli.ts "What time is it?"

# Test security
bun src/cli.ts "Read /etc/passwd"  # Should be blocked
```

### Test Checklist

- [ ] CLI works in interactive mode
- [ ] Single prompt mode works
- [ ] Security: blocked tools are denied
- [ ] Streaming responses work
- [ ] Tool notifications appear

## Pull Request Process

### Before Submitting

1. Test your changes manually
2. Update documentation if needed
3. Add to CHANGELOG if significant

### PR Requirements

- Clear title describing the change
- Description of what and why
- Reference related issues
- Include test evidence if applicable

### PR Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] New connector
- [ ] Documentation update

## Testing
How was this tested?

## Checklist
- [ ] Manual testing passed
- [ ] Documentation updated
- [ ] Code follows style guide
```

## Reporting Issues

### Bug Reports

Include:
- OpenCode version (`opencode --version`)
- Steps to reproduce
- Expected vs actual behavior
- Relevant output/logs

### Feature Requests

Include:
- Use case description
- Proposed solution
- Alternatives considered

## Security Considerations

When contributing:

1. **Never weaken permissions** - Don't add tools to the allow list without discussion
2. **Test security** - Verify prompt injection is still blocked
3. **Don't commit secrets** - Use environment variables
4. **Review carefully** - Security-sensitive code gets extra scrutiny

## Community

### Getting Help

- Open a GitHub issue
- Check existing documentation
- Review similar connectors

### Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Recognition

Contributors will be recognized in:
- CONTRIBUTORS.md file
- Release notes
- Project README (for significant contributions)

Thank you for contributing to opencode-chat-bridge!
