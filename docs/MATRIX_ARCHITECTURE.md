# Matrix Connector Architecture Decision

## Why Simple Login Instead of Application Service?

Issue [#1](https://github.com/ominiverdi/opencode-chat-bridge/issues/1) raised the question of using Matrix Application Services instead of simple username/password login.

### Research Summary

**Application Services are designed for bridges** that need to:
- Create virtual/puppet users (e.g., `@irc_alice:server`, `@telegram_bob:server`)
- Reserve user ID namespaces exclusively
- Lazily create rooms on-the-fly
- Handle hundreds of virtual users without rate limits
- Receive events via HTTP push instead of polling

**Our use case is a chat bot**, not a bridge:
- Single bot identity responding as itself
- No virtual users needed
- No namespace reservation required
- Polling (sync API) works fine for a single bot

### Trade-offs

| Aspect | Simple Login | Application Service |
|--------|--------------|---------------------|
| Setup complexity | Username/password | Registration YAML + homeserver config |
| Server requirements | Any Matrix account | Homeserver admin access required |
| Accessibility | Works on matrix.org, any public server | Self-hosted servers only |
| Virtual users | No | Yes |
| Rate limits | Standard | Exempt |
| Event delivery | Polling (sync) | HTTP push (webhooks) |
| Best for | Bots, assistants | Protocol bridges |

### Decision

**Simple login is the correct approach** for opencode-chat-bridge because:

1. **Accessibility** - Users can run the bot with any Matrix account, including on public servers like matrix.org. Application services require server admin access, limiting adoption to self-hosted setups.

2. **Simplicity** - No need to generate registration files, configure homeserver YAML, or set up webhook endpoints.

3. **Appropriate scope** - We're a single bot, not a bridge creating puppet users. Application services would be architectural overkill.

### References

- [Matrix Application Services docs](https://matrix.org/docs/older/application-services/)
- [mautrix bridge registration docs](https://docs.mau.fi/bridges/general/registering-appservices.html)

> "Only homeserver admins can allow an application service to link up with their homeserver" - Matrix.org docs

> "In general, this requires root access to the server" - mautrix docs
