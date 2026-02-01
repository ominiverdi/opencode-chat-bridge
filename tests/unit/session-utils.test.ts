/**
 * Unit tests for session-utils.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"
import {
  getSessionBaseDir,
  getSessionDir,
  ensureSessionDir,
  cleanupOldSessions,
  getSessionStorageInfo,
  estimateTokens,
  extractImagePaths,
  removeImageMarkers,
  copyOpenCodeConfig,
} from "../../src/session-utils"

// =============================================================================
// estimateTokens
// =============================================================================

describe("estimateTokens", () => {
  test("calculates tokens as chars/4", () => {
    expect(estimateTokens(100)).toBe(25)
    expect(estimateTokens(1000)).toBe(250)
    expect(estimateTokens(4)).toBe(1)
  })

  test("rounds to nearest integer", () => {
    expect(estimateTokens(5)).toBe(1)  // 5/4 = 1.25 -> 1
    expect(estimateTokens(6)).toBe(2)  // 6/4 = 1.5 -> 2
    expect(estimateTokens(7)).toBe(2)  // 7/4 = 1.75 -> 2
  })

  test("returns 0 for 0 chars", () => {
    expect(estimateTokens(0)).toBe(0)
  })

  test("handles negative values gracefully", () => {
    expect(estimateTokens(-100)).toBe(0)
  })
})

// =============================================================================
// extractImagePaths
// =============================================================================

describe("extractImagePaths", () => {
  test("extracts single image path", () => {
    const text = "Here is an image [DOCLIBRARY_IMAGE]/path/to/image.png[/DOCLIBRARY_IMAGE] for you"
    const paths = extractImagePaths(text)
    expect(paths).toEqual(["/path/to/image.png"])
  })

  test("extracts multiple image paths", () => {
    const text = `
      [DOCLIBRARY_IMAGE]/first/image.png[/DOCLIBRARY_IMAGE]
      Some text
      [DOCLIBRARY_IMAGE]/second/image.jpg[/DOCLIBRARY_IMAGE]
    `
    const paths = extractImagePaths(text)
    expect(paths).toEqual(["/first/image.png", "/second/image.jpg"])
  })

  test("returns empty array when no markers", () => {
    const text = "Just some regular text without any images"
    const paths = extractImagePaths(text)
    expect(paths).toEqual([])
  })

  test("handles case insensitive markers", () => {
    const text = "[doclibrary_image]/path/to/image.png[/doclibrary_image]"
    const paths = extractImagePaths(text)
    expect(paths).toEqual(["/path/to/image.png"])
  })

  test("trims whitespace from paths", () => {
    const text = "[DOCLIBRARY_IMAGE]  /path/with/spaces.png  [/DOCLIBRARY_IMAGE]"
    const paths = extractImagePaths(text)
    expect(paths).toEqual(["/path/with/spaces.png"])
  })

  test("handles empty string", () => {
    expect(extractImagePaths("")).toEqual([])
  })

  test("handles malformed markers gracefully", () => {
    const text = "[DOCLIBRARY_IMAGE]/unclosed/path.png"
    const paths = extractImagePaths(text)
    expect(paths).toEqual([])
  })
})

// =============================================================================
// removeImageMarkers
// =============================================================================

describe("removeImageMarkers", () => {
  test("removes single marker", () => {
    const text = "Before [DOCLIBRARY_IMAGE]/path/image.png[/DOCLIBRARY_IMAGE] After"
    const result = removeImageMarkers(text)
    expect(result).toBe("Before  After")
  })

  test("removes multiple markers", () => {
    const text = "[DOCLIBRARY_IMAGE]/a.png[/DOCLIBRARY_IMAGE] text [DOCLIBRARY_IMAGE]/b.png[/DOCLIBRARY_IMAGE]"
    const result = removeImageMarkers(text)
    expect(result).toBe("text")
  })

  test("returns original text when no markers", () => {
    const text = "Just regular text"
    const result = removeImageMarkers(text)
    expect(result).toBe("Just regular text")
  })

  test("trims result", () => {
    const text = "  [DOCLIBRARY_IMAGE]/a.png[/DOCLIBRARY_IMAGE]  "
    const result = removeImageMarkers(text)
    expect(result).toBe("")
  })

  test("handles empty string", () => {
    expect(removeImageMarkers("")).toBe("")
  })
})

// =============================================================================
// getSessionBaseDir
// =============================================================================

describe("getSessionBaseDir", () => {
  const originalEnv = process.env.SESSION_BASE_DIR

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SESSION_BASE_DIR
    } else {
      process.env.SESSION_BASE_DIR = originalEnv
    }
  })

  test("returns default path when no env var", () => {
    delete process.env.SESSION_BASE_DIR
    const result = getSessionBaseDir()
    expect(result).toBe(path.join(os.homedir(), ".cache", "opencode-chat-bridge", "sessions"))
  })

  test("returns env var path when set", () => {
    process.env.SESSION_BASE_DIR = "/custom/session/path"
    const result = getSessionBaseDir()
    expect(result).toBe("/custom/session/path")
  })
})

// =============================================================================
// getSessionDir
// =============================================================================

describe("getSessionDir", () => {
  test("creates correct path structure", () => {
    const result = getSessionDir("slack", "C123456")
    expect(result).toContain("slack")
    expect(result).toContain("C123456")
  })

  test("sanitizes special characters in identifier", () => {
    const result = getSessionDir("matrix", "!room:matrix.org")
    // The sanitized part is the identifier, not the full path
    // Full path may contain dots (like .cache)
    const identifier = result.split("/").pop()!
    expect(identifier).not.toContain("!")
    expect(identifier).not.toContain(":")
    expect(identifier).toBe("_room_matrix_org")
  })

  test("preserves allowed characters", () => {
    const result = getSessionDir("whatsapp", "123-456_ABC")
    expect(result).toContain("123-456_ABC")
  })

  test("uses custom baseDir when provided", () => {
    const result = getSessionDir("slack", "channel", { baseDir: "/custom/base" })
    expect(result).toBe("/custom/base/slack/channel")
  })
})

// =============================================================================
// getSessionStorageInfo
// =============================================================================

describe("getSessionStorageInfo", () => {
  const originalEnv = process.env.SESSION_BASE_DIR

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SESSION_BASE_DIR
    } else {
      process.env.SESSION_BASE_DIR = originalEnv
    }
  })

  test("returns default info when no env var", () => {
    delete process.env.SESSION_BASE_DIR
    const info = getSessionStorageInfo()
    expect(info.source).toContain("default")
    expect(info.baseDir).toContain(".cache")
  })

  test("returns env var info when set", () => {
    process.env.SESSION_BASE_DIR = "/custom/path"
    const info = getSessionStorageInfo()
    expect(info.source).toContain("SESSION_BASE_DIR")
    expect(info.baseDir).toBe("/custom/path")
  })
})

// =============================================================================
// ensureSessionDir (filesystem tests)
// =============================================================================

describe("ensureSessionDir", () => {
  const testDir = path.join(os.tmpdir(), "opencode-test-" + Date.now())

  afterEach(() => {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test("creates directory if it does not exist", () => {
    const sessionDir = path.join(testDir, "test-session")
    expect(fs.existsSync(sessionDir)).toBe(false)
    
    ensureSessionDir(sessionDir)
    
    expect(fs.existsSync(sessionDir)).toBe(true)
    expect(fs.statSync(sessionDir).isDirectory()).toBe(true)
  })

  test("does nothing if directory already exists", () => {
    const sessionDir = path.join(testDir, "existing-session")
    fs.mkdirSync(sessionDir, { recursive: true })
    
    // Should not throw
    ensureSessionDir(sessionDir)
    
    expect(fs.existsSync(sessionDir)).toBe(true)
  })

  test("creates nested directories", () => {
    const sessionDir = path.join(testDir, "deep", "nested", "session")
    
    ensureSessionDir(sessionDir)
    
    expect(fs.existsSync(sessionDir)).toBe(true)
  })
})

// =============================================================================
// copyOpenCodeConfig (filesystem tests)
// =============================================================================

describe("copyOpenCodeConfig", () => {
  const testDir = path.join(os.tmpdir(), "opencode-config-test-" + Date.now())
  const sourceDir = path.join(testDir, "source")
  const targetDir = path.join(testDir, "target")

  beforeEach(() => {
    fs.mkdirSync(sourceDir, { recursive: true })
    fs.mkdirSync(targetDir, { recursive: true })
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test("copies config file to target directory", () => {
    const configContent = '{"test": true}'
    fs.writeFileSync(path.join(sourceDir, "opencode.json"), configContent)

    copyOpenCodeConfig(targetDir, sourceDir)

    const targetPath = path.join(targetDir, "opencode.json")
    expect(fs.existsSync(targetPath)).toBe(true)
    expect(fs.readFileSync(targetPath, "utf-8")).toBe(configContent)
  })

  test("does nothing if source config does not exist", () => {
    // No config in sourceDir
    copyOpenCodeConfig(targetDir, sourceDir)

    const targetPath = path.join(targetDir, "opencode.json")
    expect(fs.existsSync(targetPath)).toBe(false)
  })

  test("overwrites if source is newer", async () => {
    const oldContent = '{"version": 1}'
    const newContent = '{"version": 2}'
    
    // Create old target file
    const targetPath = path.join(targetDir, "opencode.json")
    fs.writeFileSync(targetPath, oldContent)
    
    // Wait a bit then create newer source
    await new Promise(resolve => setTimeout(resolve, 100))
    fs.writeFileSync(path.join(sourceDir, "opencode.json"), newContent)

    copyOpenCodeConfig(targetDir, sourceDir)

    expect(fs.readFileSync(targetPath, "utf-8")).toBe(newContent)
  })
})

// =============================================================================
// cleanupOldSessions (filesystem tests)
// =============================================================================

describe("cleanupOldSessions", () => {
  const testBaseDir = path.join(os.tmpdir(), "opencode-cleanup-test-" + Date.now())

  beforeEach(() => {
    fs.mkdirSync(testBaseDir, { recursive: true })
  })

  afterEach(() => {
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true })
    }
  })

  test("returns 0 when no sessions exist", () => {
    const result = cleanupOldSessions("slack", 7, { baseDir: testBaseDir })
    expect(result).toBe(0)
  })

  test("does not delete recent sessions", () => {
    // Create a session directory
    const sessionDir = path.join(testBaseDir, "slack", "recent-session")
    fs.mkdirSync(sessionDir, { recursive: true })

    const result = cleanupOldSessions("slack", 7, { baseDir: testBaseDir })
    
    expect(result).toBe(0)
    expect(fs.existsSync(sessionDir)).toBe(true)
  })

  test("deletes old sessions", () => {
    // Create an old session directory
    const sessionDir = path.join(testBaseDir, "matrix", "old-session")
    fs.mkdirSync(sessionDir, { recursive: true })
    
    // Set mtime to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    fs.utimesSync(sessionDir, tenDaysAgo, tenDaysAgo)

    const result = cleanupOldSessions("matrix", 7, { baseDir: testBaseDir })
    
    expect(result).toBe(1)
    expect(fs.existsSync(sessionDir)).toBe(false)
  })

  test("handles mixed old and new sessions", () => {
    const connectorDir = path.join(testBaseDir, "whatsapp")
    const oldSession = path.join(connectorDir, "old-session")
    const newSession = path.join(connectorDir, "new-session")
    
    fs.mkdirSync(oldSession, { recursive: true })
    fs.mkdirSync(newSession, { recursive: true })
    
    // Set old session to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    fs.utimesSync(oldSession, tenDaysAgo, tenDaysAgo)

    const result = cleanupOldSessions("whatsapp", 7, { baseDir: testBaseDir })
    
    expect(result).toBe(1)
    expect(fs.existsSync(oldSession)).toBe(false)
    expect(fs.existsSync(newSession)).toBe(true)
  })
})
