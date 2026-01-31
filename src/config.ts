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
  deviceId: string
  encryption: {
    enabled: boolean
    storePath: string
  }
  autoJoin: boolean
  triggerPatterns: string[]
  ignoreRooms: string[]
  ignoreUsers: string[]
}

export interface WhatsAppConfig {
  enabled: boolean
  authFolder: string
  allowedNumbers: string[]
}

export interface ChatBridgeConfig {
  botName: string
  trigger: string
  rateLimitSeconds: number
  sessionStorePath: string
  defaultAgent: string | null
  modes: Record<string, string>
  matrix: MatrixConfig
  whatsapp: WhatsAppConfig
}

// Default configuration
const defaultConfig: ChatBridgeConfig = {
  botName: "oc",
  trigger: "!oc",
  rateLimitSeconds: 5,
  sessionStorePath: "./.opencode/chat-sessions.json",
  defaultAgent: null,
  modes: {},
  matrix: {
    enabled: false,
    homeserver: "https://matrix.org",
    userId: "",
    accessToken: "",
    deviceId: "OPENCODE_BRIDGE",
    encryption: {
      enabled: false,
      storePath: "./matrix-store/"
    },
    autoJoin: true,
    triggerPatterns: ["!oc "],
    ignoreRooms: [],
    ignoreUsers: []
  },
  whatsapp: {
    enabled: false,
    authFolder: "./.whatsapp-auth",
    allowedNumbers: []
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

let cachedConfig: ChatBridgeConfig | null = null

/**
 * Load configuration from chat-bridge.json
 */
export function loadConfig(configPath?: string): ChatBridgeConfig {
  if (cachedConfig) return cachedConfig
  
  const searchPaths = configPath 
    ? [configPath]
    : [
        path.join(process.cwd(), "chat-bridge.json"),
        path.join(process.cwd(), "chat-bridge.jsonc"),
      ]
  
  for (const filePath of searchPaths) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8")
        const parsed = JSON.parse(content)
        const substituted = substituteEnvVars(parsed)
        cachedConfig = deepMerge(defaultConfig, substituted)
        console.log(`[CONFIG] Loaded from ${filePath}`)
        return cachedConfig
      } catch (err) {
        console.error(`[CONFIG] Error loading ${filePath}:`, err)
      }
    }
  }
  
  console.log("[CONFIG] No config file found, using defaults")
  cachedConfig = defaultConfig
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
