/**
 * Configuration loader for chat-bridge
 * 
 * Loads settings from chat-bridge.json with environment variable substitution.
 */

import * as fs from "fs"
import * as path from "path"

export interface MatrixConfig {
  enabled: boolean
  homeserver: string
  userId: string
  accessToken: string
  password: string  // For password-based login (auto-generates tokens)
  deviceId: string
  encryption: {
    enabled: boolean
    storePath: string
  }
  autoJoin: boolean
  triggerPatterns: string[]
  ignoreRooms: string[]
  ignoreUsers: string[]
  allowedUsers: string[]
  formatHtml: boolean
  threadIsolation: boolean  // true: per-thread sessions + thread replies, false: per-room
}

export interface MattermostConfig {
  enabled: boolean
  url: string            // Mattermost server URL (e.g., https://mattermost.example.com)
  token: string          // Bot access token
  teamName: string       // Team to connect to (URL slug, e.g., "myteam")
  respondToMentions: boolean // Respond when @mentioned (in addition to trigger)
  ignoreChannels: string[] // Channel IDs to ignore
  ignoreUsers: string[]    // User IDs to ignore
  allowedUsers: string[]
  threadIsolation: boolean // true: per-thread sessions + thread replies, false: per-channel
}

export interface WhatsAppConfig {
  enabled: boolean
  authFolder: string
  allowedUsers: string[]
  respondToOthers: boolean
}

export interface SlackConfig {
  enabled: boolean
  allowedUsers: string[]
  threadIsolation: boolean  // true: per-thread sessions + thread replies, false: per-channel
}

export interface DiscordConfig {
  enabled: boolean
  allowedUsers: string[]
}

export interface TelegramAttachmentsConfig {
  enabled: boolean
  maxFileBytes: number
  maxFilesPerMessage: number
}

export interface TelegramConfig {
  enabled: boolean
  /** Bot token from @BotFather -- env: TELEGRAM_BOT_TOKEN */
  token: string
  /** Respond when @-mentioned in groups (in addition to trigger) */
  respondToMentions: boolean
  /** Per-topic sessions in forum supergroups (chatId:messageThreadId).
   *  When false, all messages in a chat share one session. */
  threadIsolation: boolean
  /** Respond when the user replies (swipe-reply) to a message from this bot,
   *  even when the message doesn't start with the trigger or @mention.
   *  Always on in DMs (no-op), and in groups/topic replies the connector
   *  requires an active session for the same chat/topic first so the bot
   *  doesn't pick up stale replies from days-old conversations. */
  respondToReplies: boolean
  /** Download incoming Telegram media into the session workspace for the LLM. */
  attachments: TelegramAttachmentsConfig
  /** Comma-separated Telegram numeric chat IDs and/or user IDs to ignore */
  ignoreChats: string[]
  /** Comma-separated Telegram numeric user IDs to ignore */
  ignoreUsers: string[]
  allowedUsers: string[]
}


export interface WebConfig {
  enabled: boolean
  port: number
  host: string
  allowedOrigins: string[]  // CORS origins, ["*"] = any
  publicUrl: string         // Override for logs/snippets (e.g. behind reverse proxy)
}

export interface ACPConfig {
  command: string
  args: string[]
  backendId: string
  profileDir: string
}

export interface SessionPickerConfig {
  enabled: boolean
  connectors: string[]
  mirrorIntervalSeconds: number
}

export type ToolMessageMode = "off" | "events" | "status" | "trace"

export interface ToolMessagesConfig {
  /** Tool-call presentation. Defaults to one immutable message per call. */
  mode?: ToolMessageMode
  /** Legacy switch for tool call notices. False always resolves to mode "off". */
  showCalls: boolean
  /** Include compact tool arguments in call notices. */
  showArguments: boolean
  /** Tool name substrings whose output is forwarded to chat. */
  showOutputFor: string[]
  /** Maximum tool calls retained in an editable trace message. */
  maxTraceEntries?: number
}

export interface ChatBridgeConfig {
  botName: string
  trigger: string
  rateLimitSeconds: number
  sessionStorePath: string
  defaultAgent: string | null
  toolMessages: ToolMessagesConfig
  verboseErrors: boolean  // Send detailed error messages to the user
  sessionPicker: SessionPickerConfig
  acp: ACPConfig
  matrix: MatrixConfig
  mattermost: MattermostConfig
  whatsapp: WhatsAppConfig
  slack: SlackConfig
  discord: DiscordConfig
  telegram: TelegramConfig
  web: WebConfig
}

// Default configuration
const defaultConfig: ChatBridgeConfig = {
  botName: "oc",
  trigger: "!oc",
  rateLimitSeconds: 5,
  sessionStorePath: "./.opencode/chat-sessions.json",
  defaultAgent: null,
  verboseErrors: false,
  toolMessages: {
    mode: "events",
    showCalls: true,
    showArguments: false,
    showOutputFor: ["bash"],
    maxTraceEntries: 20,
  },
  sessionPicker: {
    enabled: false,
    connectors: [],
    mirrorIntervalSeconds: 60,
  },
  acp: {
    command: "opencode",
    args: ["acp"],
    backendId: "",
    profileDir: "",
  },
  matrix: {
    enabled: false,
    homeserver: "https://matrix.org",
    userId: "",
    accessToken: "",
    password: "",  // For password-based login
    deviceId: "OPENCODE_BRIDGE",
    encryption: {
      enabled: false,
      storePath: "./matrix-store/"
    },
    autoJoin: true,
    triggerPatterns: ["!oc "],
    ignoreRooms: [],
    ignoreUsers: [],
    allowedUsers: [],
    formatHtml: false,
    threadIsolation: true,  // Per-thread sessions by default
  },
  mattermost: {
    enabled: false,
    url: "",
    token: "",
    teamName: "",
    respondToMentions: true,
    ignoreChannels: [],
    ignoreUsers: [],
    allowedUsers: [],
    threadIsolation: true,  // Per-thread sessions by default
  },
  whatsapp: {
    enabled: false,
    authFolder: "./.whatsapp-auth",
    allowedUsers: [],
    respondToOthers: true
  },
  slack: {
    enabled: false,
    allowedUsers: [],
    threadIsolation: true,  // Per-thread sessions by default
  },
  discord: {
    enabled: false,
    allowedUsers: [],
  },
  telegram: {
    enabled: false,
    token: "",
    respondToMentions: true,
    threadIsolation: true,
    respondToReplies: true,
    attachments: {
      enabled: true,
      maxFileBytes: 20 * 1024 * 1024,
      maxFilesPerMessage: 4,
    },
    ignoreChats: [],
    ignoreUsers: [],
    allowedUsers: [],
  },
  web: {
    enabled: false,
    port: 3420,
    host: "0.0.0.0",
    allowedOrigins: ["*"],
    publicUrl: "",
  }
}

/**
 * Replace {env:VAR_NAME} patterns with environment variables
 */
function substituteEnvVars(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || ""
    })
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVars)
  }
  if (obj && typeof obj === "object") {
    const result: any = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVars(value)
    }
    return result
  }
  return obj
}

/**
 * Deep merge two objects
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target }
  for (const key in source) {
    const sourceValue = source[key]
    const targetValue = (target as any)[key]
    
    if (sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue) &&
        targetValue && typeof targetValue === "object" && !Array.isArray(targetValue)) {
      (result as any)[key] = deepMerge(targetValue, sourceValue)
    } else if (sourceValue !== undefined) {
      (result as any)[key] = sourceValue
    }
  }
  return result
}

const TOOL_MESSAGE_MODES = new Set<ToolMessageMode>(["off", "events", "status", "trace"])

function normalizeToolMessages(config: ChatBridgeConfig): void {
  const mode = config.toolMessages.mode
  if (!mode || !TOOL_MESSAGE_MODES.has(mode)) {
    if (mode) console.warn(`[CONFIG] Invalid toolMessages.mode "${mode}"; using "events"`)
    config.toolMessages.mode = "events"
  }

  const maxEntries = config.toolMessages.maxTraceEntries
  if (!Number.isInteger(maxEntries) || (maxEntries || 0) < 1) {
    console.warn("[CONFIG] Invalid toolMessages.maxTraceEntries; using 20")
    config.toolMessages.maxTraceEntries = 20
  }
}

let cachedConfig: ChatBridgeConfig | null = null

/**
 * Load configuration from chat-bridge.json
 */
export function loadConfig(configPath?: string): ChatBridgeConfig {
  if (cachedConfig) return cachedConfig
  
  const searchPaths = configPath 
    ? [configPath]
    : [path.join(process.cwd(), "chat-bridge.json")]
  
  for (const filePath of searchPaths) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8")
        const parsed = JSON.parse(content)

        // Backward compatibility for the former top-level streamTools option.
        // The public configuration now groups all chat-visible tool activity
        // under toolMessages.
        if (Array.isArray(parsed.streamTools)) {
          parsed.toolMessages = {
            ...(parsed.toolMessages || {}),
            showOutputFor: parsed.toolMessages?.showOutputFor ?? parsed.streamTools,
          }
          delete parsed.streamTools
        }

        const substituted = substituteEnvVars(parsed)
        cachedConfig = deepMerge(defaultConfig, substituted)
        normalizeToolMessages(cachedConfig)
        console.log(`[CONFIG] Loaded from ${filePath}`)
        return cachedConfig
      } catch (err) {
        console.error(`[CONFIG] Error loading ${filePath}:`, err)
      }
    }
  }
  
  console.log("[CONFIG] No config file found, using defaults")
  cachedConfig = deepMerge(defaultConfig, {})
  normalizeToolMessages(cachedConfig)
  return cachedConfig
}

/**
 * Get the current configuration (loads if not already loaded)
 */
export function getConfig(): ChatBridgeConfig {
  return cachedConfig || loadConfig()
}

/**
 * Clear cached config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null
}
