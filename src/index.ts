/**
 * OpenCode Chat Bridge
 * ACP-based client for OpenCode with skills support
 * 
 * Usage:
 *   CLI: bun src/cli.ts [options] [prompt]
 *   Library: import { ACPClient } from "opencode-chat-bridge"
 */

export { ACPClient, type ACPClientOptions, type MCPServer, type SessionUpdate, type ActivityEvent, type ImageContent } from "./acp-client"
export { loadSkills, getSkill, listSkills, type Skill } from "./skills"
export { getConfig, loadConfig, clearConfigCache, type ChatBridgeConfig, type MatrixConfig, type WhatsAppConfig } from "./config"
export { 
  getSessionDir, 
  ensureSessionDir, 
  cleanupOldSessions, 
  getSessionStorageInfo, 
  getSessionBaseDir, 
  estimateTokens,
  extractImagePaths,
  removeImageMarkers,
  copyOpenCodeConfig,
  type SessionConfig 
} from "./session-utils"

// Connector base classes and utilities
export {
  BaseConnector,
  SessionManager,
  RateLimiter,
  CommandHandler,
  type BaseSession,
  type SessionStats,
  type ConnectorConfig,
} from "./connector-base"

export { ImageHandler, type ImageUploadCallback } from "./image-handler"
