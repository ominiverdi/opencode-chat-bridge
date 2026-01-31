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
