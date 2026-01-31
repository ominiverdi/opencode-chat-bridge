/**
 * Session directory management utilities
 * 
 * Stores bot sessions OUTSIDE the project git repo to ensure each session
 * gets its own unique OpenCode project hash. This prevents bot sessions
 * from cluttering developer session lists.
 * 
 * Default location: ~/.cache/opencode-chat-bridge/sessions/<connector>/<channel>/
 * Override with: SESSION_BASE_DIR environment variable
 */

import fs from "fs"
import path from "path"
import os from "os"

export interface SessionConfig {
  baseDir?: string
  retentionDays?: number
}

/**
 * Get the base directory for all sessions.
 * Uses SESSION_BASE_DIR env var, or defaults to ~/.cache/opencode-chat-bridge/sessions
 * 
 * IMPORTANT: This MUST be outside any git repo to ensure OpenCode creates
 * unique project hashes for each session directory.
 */
export function getSessionBaseDir(): string {
  // Allow override via environment variable
  if (process.env.SESSION_BASE_DIR) {
    return process.env.SESSION_BASE_DIR
  }
  
  // Default: ~/.cache/opencode-chat-bridge/sessions
  // This is outside any git repo, so each session dir gets unique project hash
  return path.join(os.homedir(), ".cache", "opencode-chat-bridge", "sessions")
}

/**
 * Get session directory path for a connector and identifier
 * @param connector - Connector name (slack, matrix, whatsapp)
 * @param identifier - Channel/room ID
 * @param config - Optional configuration
 */
export function getSessionDir(
  connector: string,
  identifier: string,
  config: SessionConfig = {}
): string {
  const baseDir = config.baseDir || getSessionBaseDir()
  const sessionRoot = path.join(baseDir, connector)
  
  // Sanitize identifier for filesystem (remove special chars)
  const sanitized = identifier.replace(/[^a-zA-Z0-9_-]/g, "_")
  
  return path.join(sessionRoot, sanitized)
}

/**
 * Ensure session directory exists, create if needed
 */
export function ensureSessionDir(sessionDir: string): void {
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true })
  }
}

/**
 * Cleanup old session directories
 * @param connector - Connector name to clean
 * @param maxAgeDays - Delete sessions older than this
 * @param config - Optional configuration
 * @returns Number of sessions cleaned up
 */
export function cleanupOldSessions(
  connector: string,
  maxAgeDays: number,
  config: SessionConfig = {}
): number {
  const baseDir = config.baseDir || getSessionBaseDir()
  const sessionRoot = path.join(baseDir, connector)
  
  if (!fs.existsSync(sessionRoot)) {
    return 0
  }
  
  let cleanedCount = 0
  const now = Date.now()
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
  
  try {
    const dirs = fs.readdirSync(sessionRoot)
    
    for (const dir of dirs) {
      const fullPath = path.join(sessionRoot, dir)
      
      try {
        const stat = fs.statSync(fullPath)
        
        // Skip if not a directory
        if (!stat.isDirectory()) continue
        
        // Check age based on last modified time
        const ageMs = now - stat.mtime.getTime()
        
        if (ageMs > maxAgeMs) {
          fs.rmSync(fullPath, { recursive: true, force: true })
          cleanedCount++
        }
      } catch (err) {
        console.error(`Error processing session dir ${dir}:`, err)
      }
    }
  } catch (err) {
    console.error(`Error reading session directory ${sessionRoot}:`, err)
  }
  
  return cleanedCount
}

/**
 * Get storage info for logging/debugging
 */
export function getSessionStorageInfo(): {
  baseDir: string
  source: string
} {
  const envDir = process.env.SESSION_BASE_DIR
  return {
    baseDir: envDir || getSessionBaseDir(),
    source: envDir ? "SESSION_BASE_DIR env var" : "default (~/.cache/opencode-chat-bridge/sessions)"
  }
}

/**
 * Estimate token count from character count.
 * Matches OpenCode's internal estimation: src/util/token.ts
 * 
 * @param chars - Number of characters
 * @returns Estimated token count (chars / 4, rounded)
 */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4))
}

// =============================================================================
// Image Marker Utilities
// =============================================================================

/**
 * Image marker format used by doclibrary MCP server
 * Format: [DOCLIBRARY_IMAGE]/path/to/file.png[/DOCLIBRARY_IMAGE]
 */
const IMAGE_MARKER_REGEX = /\[DOCLIBRARY_IMAGE\]([^\[]+)\[\/DOCLIBRARY_IMAGE\]/gi

/**
 * Extract image file paths from text containing doclibrary markers
 * 
 * @param text - Text that may contain image markers
 * @returns Array of file paths extracted from markers
 */
export function extractImagePaths(text: string): string[] {
  const paths: string[] = []
  let match: RegExpExecArray | null
  
  // Reset lastIndex in case regex was used before
  IMAGE_MARKER_REGEX.lastIndex = 0
  
  while ((match = IMAGE_MARKER_REGEX.exec(text)) !== null) {
    const imagePath = match[1].trim()
    if (imagePath) {
      paths.push(imagePath)
    }
  }
  
  return paths
}

/**
 * Remove all image markers from text
 * 
 * @param text - Text containing image markers
 * @returns Text with all [DOCLIBRARY_IMAGE]...[/DOCLIBRARY_IMAGE] markers removed
 */
export function removeImageMarkers(text: string): string {
  return text.replace(/\[DOCLIBRARY_IMAGE\][^\[]+\[\/DOCLIBRARY_IMAGE\]/gi, "").trim()
}
