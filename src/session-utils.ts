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
 * Copy a config file to session directory if source is newer or target doesn't exist.
 */
function copyIfNewer(sourceDir: string, sessionDir: string, fileName: string): void {
  const sourcePath = path.join(sourceDir, fileName)
  const targetPath = path.join(sessionDir, fileName)
  
  if (fs.existsSync(sourcePath)) {
    try {
      const sourceStats = fs.statSync(sourcePath)
      const targetExists = fs.existsSync(targetPath)
      
      if (!targetExists || sourceStats.mtime > fs.statSync(targetPath).mtime) {
        fs.copyFileSync(sourcePath, targetPath)
        console.log(`  Copied ${fileName} to session directory`)
      }
    } catch (err) {
      console.error(`Failed to copy ${fileName}:`, err)
    }
  }
}

/**
 * Copy or symlink a directory to session directory.
 */
function symlinkDir(sourceDir: string, sessionDir: string, dirName: string): void {
  const sourcePath = path.join(sourceDir, dirName)
  const targetPath = path.join(sessionDir, dirName)
  
  if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
    try {
      // Remove existing symlink or directory
      if (fs.existsSync(targetPath)) {
        const stat = fs.lstatSync(targetPath)
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(targetPath)
        } else {
          fs.rmSync(targetPath, { recursive: true })
        }
      }
      
      // Create symlink to source directory
      fs.symlinkSync(sourcePath, targetPath, "dir")
      console.log(`  Symlinked ${dirName} to session directory`)
    } catch (err) {
      console.error(`Failed to symlink ${dirName}:`, err)
    }
  }
}

/**
 * Copy config files to session directory.
 * 
 * OpenCode looks for config in the working directory (cwd).
 * Since sessions run from ~/.cache/..., we copy these files there:
 * - opencode.json: Agent config with tool permissions
 * - AGENTS.md: Instructions that override global AGENTS.md
 * - .opencode/skills/: Symlinked for skill discovery
 * 
 * @param sessionDir - Target session directory
 * @param projectDir - Source project directory (default: process.cwd())
 */
export function copyOpenCodeConfig(sessionDir: string, projectDir?: string): void {
  const sourceDir = projectDir || process.cwd()
  
  copyIfNewer(sourceDir, sessionDir, "opencode.json")
  copyIfNewer(sourceDir, sessionDir, "AGENTS.md")
  
  // Symlink .opencode directory for skills, tools, commands
  symlinkDir(sourceDir, sessionDir, ".opencode")
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
 * Image path format used by generate_image plugin
 * Format: Path: /path/to/file.png
 */
const IMAGE_PATH_REGEX = /Path:\s*(\/[^\s\n]+\.(?:png|jpg|jpeg|gif|webp))/gi

/**
 * Extract image file paths from text containing image markers or path references
 * 
 * Supports:
 * - [DOCLIBRARY_IMAGE]/path/to/file.png[/DOCLIBRARY_IMAGE] (doclibrary)
 * - Path: /path/to/file.png (generate_image plugin)
 * 
 * @param text - Text that may contain image markers or paths
 * @returns Array of file paths extracted
 */
export function extractImagePaths(text: string): string[] {
  const paths: string[] = []
  let match: RegExpExecArray | null
  
  // Reset lastIndex in case regex was used before
  IMAGE_MARKER_REGEX.lastIndex = 0
  IMAGE_PATH_REGEX.lastIndex = 0
  
  // Extract from [DOCLIBRARY_IMAGE] markers
  while ((match = IMAGE_MARKER_REGEX.exec(text)) !== null) {
    const imagePath = match[1].trim()
    if (imagePath && !paths.includes(imagePath)) {
      paths.push(imagePath)
    }
  }
  
  // Extract from "Path: /path/to/file" format
  while ((match = IMAGE_PATH_REGEX.exec(text)) !== null) {
    const imagePath = match[1].trim()
    if (imagePath && !paths.includes(imagePath)) {
      paths.push(imagePath)
    }
  }
  
  return paths
}

/**
 * Remove all image markers and path references from text
 * 
 * @param text - Text containing image markers or path references
 * @returns Text with markers and path lines removed
 */
export function removeImageMarkers(text: string): string {
  return text
    .replace(/\[DOCLIBRARY_IMAGE\][^\[]+\[\/DOCLIBRARY_IMAGE\]/gi, "")
    .replace(/Path:\s*\/[^\s\n]+\.(?:png|jpg|jpeg|gif|webp)\n?/gi, "")
    .trim()
}

/**
 * Sanitize server paths from text for security
 * Replaces absolute paths with just the filename
 * 
 * Example: "/home/user/.cache/opencode/file.jpg" -> "file.jpg"
 * 
 * @param text - Text that may contain server paths
 * @returns Text with absolute paths replaced by filenames
 */
export function sanitizeServerPaths(text: string): string {
  // Match absolute paths: /path/to/filename.ext
  // Captures paths starting with / followed by path segments and a filename with extension
  return text.replace(
    /\/(?:[\w.-]+\/)+([^\/\s]+\.[a-zA-Z0-9]+)/g,
    (match, filename) => filename
  )
}
