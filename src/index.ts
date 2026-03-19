/**
 * OpenCode Chat Bridge
 * ACP-based client for OpenCode
 * 
 * Usage:
 *   CLI: bun src/cli.ts [prompt]
 *   Library: import { ACPClient } from "opencode-chat-bridge"
 */

export { ACPClient, type ACPClientOptions, type MCPServer, type SessionUpdate, type ActivityEvent, type ImageContent, type OpenCodeCommand } from "./acp-client"
export { getConfig, loadConfig, clearConfigCache, type ChatBridgeConfig, type MatrixConfig, type MattermostConfig, type WhatsAppConfig } from "./config"
export { 
  getSessionDir, 
  ensureSessionDir, 
  cleanupOldSessions, 
  getSessionStorageInfo, 
  getSessionBaseDir, 
  estimateTokens,
  extractImagePaths,
  extractDocPaths,
  removeImageMarkers,
  removeDocMarkers,
  sanitizeServerPaths,
  copyOpenCodeConfig,
  type SessionConfig 
} from "./session-utils"

// Connector base classes and utilities
export {
  BaseConnector,
  SessionManager,
  RateLimiter,
  EventDeduplicator,
  CommandHandler,
  type BaseSession,
  type SessionStats,
  type ConnectorConfig,
} from "./connector-base"

export { ImageHandler, type ImageUploadCallback, DocHandler, type DocUploadCallback } from "./image-handler"
