# Security Considerations

Running an AI agent accessible via public chat requires careful security configuration.

## Threat Model

### Potential Risks

1. **Unauthorized code execution** - Malicious users trick the AI into running harmful commands
2. **Data exfiltration** - AI reads sensitive files and leaks them to chat
3. **Resource abuse** - Users consume excessive API credits or compute
4. **Spam/abuse** - Bot used to spam rooms or harass users
5. **Prompt injection** - Users manipulate AI behavior through crafted inputs

## Recommended OpenCode Permissions

For chat bot use cases, use a restrictive permission model:

```json
{
  "$schema": "https://opencode.ai/config.json",
  
  "permission": {
    // Deny everything by default
    "*": "deny",
    
    // Allow web fetching (for research)
    "webfetch": "allow",
    
    // Deny file operations
    "read": "deny",
    "edit": "deny",
    "write": "deny",
    
    // Deny shell access
    "bash": "deny",
    
    // Deny access outside project
    "external_directory": "deny",
    
    // Allow your MCP tools
    "my-knowledge-base_*": "allow"
  }
}
```

## Permission Levels

| Level | Use Case |
|-------|----------|
| `allow` | Safe operations, custom MCP tools |
| `ask` | Operations requiring human approval |
| `deny` | Dangerous operations |

### For Public Bots

```json
{
  "permission": {
    "*": "deny",
    "webfetch": "allow"
  }
}
```

### For Team/Internal Bots

```json
{
  "permission": {
    "*": "ask",
    "webfetch": "allow",
    "read": "allow",
    "edit": "ask",
    "bash": "deny"
  }
}
```

### For Development/Testing

```json
{
  "permission": {
    "*": "allow",
    "bash": "ask"
  }
}
```

## Chat-Level Security

### User Filtering

Ignore known bad actors:

```json
{
  "matrix": {
    "ignoreUsers": [
      "@spammer:example.com"
    ]
  }
}
```

### Room Filtering

Only operate in specific rooms:

```json
{
  "matrix": {
    "ignoreRooms": [
      "!public-spam:matrix.org"
    ]
  }
}
```

### Trigger Patterns

Require explicit invocation to prevent accidental triggering:

```json
{
  "matrix": {
    "triggerPatterns": [
      "@mybot:"
    ]
  }
}
```

## Rate Limiting

### At Chat Protocol Level

Matrix and Discord have built-in rate limits. The bridge respects these.

### At Application Level (Planned)

Future feature: per-user rate limiting

```json
{
  "rateLimiting": {
    "enabled": true,
    "requestsPerMinute": 10,
    "requestsPerHour": 100
  }
}
```

## Credential Security

### Environment Variables

Never commit credentials to git:

```json
{
  "matrix": {
    "accessToken": "{env:MATRIX_ACCESS_TOKEN}"
  }
}
```

### File Permissions

Protect config files:

```bash
chmod 600 chat-bridge.json
chmod 600 .env
```

### Token Rotation

Periodically rotate access tokens:
1. Generate new token
2. Update environment variable
3. Restart bridge
4. Revoke old token

## Monitoring

### Log Monitoring

Watch for suspicious patterns:
- Repeated failed requests
- Unusual command patterns
- High request volume from single user

```bash
tail -f ~/.opencode/logs/*.log | grep -E "(error|warn|denied)"
```

### Usage Monitoring

Track API usage to detect abuse:
- Monitor OpenCode token consumption
- Set up alerts for unusual spikes
- Review session logs periodically

## Deployment Security

### Process Isolation

Run the bridge with limited privileges:

```bash
# Create dedicated user
useradd -r -s /bin/false opencode-bridge

# Run as that user
sudo -u opencode-bridge opencode
```

### Container Isolation

Use Docker for additional isolation:

```dockerfile
FROM node:22-slim
USER node
WORKDIR /app
# ... rest of Dockerfile
```

### Network Isolation

Limit network access:
- Only allow outbound to Matrix homeserver
- Only allow outbound to AI APIs
- Block all other outbound traffic

## Incident Response

### If Bot is Compromised

1. **Revoke access token immediately**
2. Stop the bridge process
3. Audit logs for actions taken
4. Notify affected users/rooms
5. Generate new credentials
6. Review and fix vulnerability

### If Abuse is Detected

1. Add user to ignore list
2. Consider leaving the room
3. Report to homeserver admin if severe
4. Document for pattern recognition

## Security Checklist

Before going live:

- [ ] Permissions locked down (`*: deny`)
- [ ] Access token in environment variable
- [ ] Config files have restricted permissions
- [ ] Bot account is dedicated (not personal)
- [ ] Trigger patterns require explicit invocation
- [ ] Logging is enabled
- [ ] Have a plan for token rotation
- [ ] Know how to quickly disable the bot

## Security Updates

Stay updated:
- Watch OpenCode releases for security fixes
- Monitor matrix-js-sdk for vulnerabilities
- Update dependencies regularly

```bash
# Check for updates
bun update

# Audit dependencies
bun audit
```
