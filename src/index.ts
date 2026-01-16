/**
 * OpenCode Chat Bridge Plugin
 * 
 * Bridges OpenCode AI coding sessions to chat protocols like Matrix, Discord, IRC.
 * 
 * Usage:
 *   1. Add to opencode.json: "plugin": ["opencode-chat-bridge"]
 *   2. Configure chatBridge section with protocol settings
 *   3. Run opencode - the bridge starts automatically
 * 
 * @example
 * // opencode.json
 * {
 *   "plugin": ["opencode-chat-bridge"],
 *   "chatBridge": {
 *     "matrix": {
 *       "enabled": true,
 *       "homeserver": "https://matrix.org",
 *       "userId": "@bot:matrix.org",
 *       "accessToken": "{env:MATRIX_ACCESS_TOKEN}"
 *     }
 *   }
 * }
 */

import type { Plugin, Hooks, PluginInput } from '@opencode-ai/plugin'
import { Bridge, type BridgeOpenCodeClient } from './bridge'
import { SessionManager } from './session-manager'
import { MatrixProtocol } from './protocols/matrix/client'
import type { MatrixConfig } from './protocols/matrix/types'

// Re-export types for external use
export type { ChatProtocol, ChatMessage, SendOptions } from './protocols/base'
export type { MatrixConfig } from './protocols/matrix/types'
export { MatrixProtocol } from './protocols/matrix/client'
export { Bridge } from './bridge'
export { SessionManager } from './session-manager'

/**
 * Chat Bridge plugin configuration
 */
export interface ChatBridgeConfig {
  /** Matrix protocol configuration */
  matrix?: MatrixConfig
  /** Discord configuration (future) */
  discord?: {
    enabled: boolean
    token: string
    // ... Discord-specific config
  }
  /** IRC configuration (future) */
  irc?: {
    enabled: boolean
    server: string
    nick: string
    channels: string[]
    // ... IRC-specific config
  }
  /** Session persistence path */
  sessionStorePath?: string
  /** Default agent to use for all protocols */
  defaultAgent?: string
  /** Global mode mappings */
  modes?: Record<string, string>
}

/**
 * Resolve environment variable references in config
 * Handles {env:VAR_NAME} syntax
 */
function resolveEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = value.match(/^\{env:(\w+)\}$/)
    if (match) {
      const envValue = process.env[match[1]]
      if (!envValue) {
        console.warn(`[chat-bridge] Environment variable ${match[1]} not set`)
      }
      return envValue ?? ''
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars)
  }
  if (typeof value === 'object' && value !== null) {
    const resolved: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveEnvVars(v)
    }
    return resolved
  }
  return value
}

// Store bridge reference for cleanup
let activeBridge: Bridge | null = null

/**
 * Main plugin export
 */
export const ChatBridgePlugin: Plugin = async (ctx: PluginInput): Promise<Hooks> => {
  // Get config from opencode.json chatBridge section
  // Note: ctx.config would contain the full config, we need to extract chatBridge
  // For now, we'll read from a separate config or environment
  
  const configRaw = await loadConfig(ctx.directory)
  if (!configRaw) {
    console.log('[chat-bridge] No chatBridge configuration found, plugin disabled')
    // Return empty hooks object - all properties are optional
    return {}
  }

  const config = resolveEnvVars(configRaw) as ChatBridgeConfig

  // Initialize session manager
  const sessionManager = new SessionManager({
    persistPath: config.sessionStorePath ?? `${ctx.directory}/.opencode/chat-sessions.json`,
  })

  // Initialize bridge with OpenCode client
  // Cast to our simplified client interface
  const bridge = new Bridge(ctx.client as unknown as BridgeOpenCodeClient, {
    sessionManager,
    defaultAgent: config.defaultAgent,
    modes: config.modes ?? {
      '!s': 'serious',
      '!d': 'sarcastic',
      '!a': 'agent',
      '!p': 'plan',
    },
  })
  activeBridge = bridge

  // Add enabled protocols
  if (config.matrix?.enabled) {
    console.log('[chat-bridge] Enabling Matrix protocol')
    bridge.addProtocol(new MatrixProtocol(config.matrix))
  }

  // Future: Discord, IRC, etc.
  // if (config.discord?.enabled) {
  //   bridge.addProtocol(new DiscordProtocol(config.discord))
  // }

  // Start the bridge
  await bridge.start()
  console.log('[chat-bridge] Plugin initialized')

  // Return hooks for OpenCode events
  const hooks: Hooks = {
    // Listen to all events and filter for ones we care about
    event: async ({ event }) => {
      // Handle session-related events
      if (event.type === 'session.error') {
        console.log('[chat-bridge] Session error event:', event)
      }
    },
  }

  return hooks
}

/**
 * Load chat bridge configuration
 */
async function loadConfig(directory: string): Promise<ChatBridgeConfig | null> {
  // Try multiple config locations
  const locations = [
    `${directory}/chat-bridge.json`,
    `${directory}/.opencode/chat-bridge.json`,
    `${process.env.HOME}/.config/opencode/chat-bridge.json`,
  ]

  for (const path of locations) {
    try {
      const file = Bun.file(path)
      if (await file.exists()) {
        console.log(`[chat-bridge] Loading config from ${path}`)
        return await file.json()
      }
    } catch {
      // Continue to next location
    }
  }

  // Also try reading from opencode.json chatBridge section
  try {
    const opencodeConfig = Bun.file(`${directory}/opencode.json`)
    if (await opencodeConfig.exists()) {
      const config = await opencodeConfig.json() as { chatBridge?: ChatBridgeConfig }
      if (config.chatBridge) {
        console.log('[chat-bridge] Loading config from opencode.json')
        return config.chatBridge
      }
    }
  } catch {
    // Ignore errors
  }

  return null
}

// Default export for OpenCode plugin system
export default ChatBridgePlugin
