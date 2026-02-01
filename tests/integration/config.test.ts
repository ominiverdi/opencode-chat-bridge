/**
 * Integration tests for config.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"
import { loadConfig, getConfig, clearConfigCache } from "../../src/config"

describe("config", () => {
  const testDir = path.join(os.tmpdir(), "config-test-" + Date.now())
  const originalCwd = process.cwd()
  const originalEnv = { ...process.env }

  beforeEach(() => {
    clearConfigCache()
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    clearConfigCache()
    process.chdir(originalCwd)
    // Restore env vars
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, originalEnv)
    
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe("loadConfig", () => {
    test("returns defaults when no config file exists", () => {
      process.chdir(testDir)
      
      const config = loadConfig()
      
      expect(config.botName).toBe("oc")
      expect(config.trigger).toBe("!oc")
      expect(config.rateLimitSeconds).toBe(5)
      expect(config.matrix.enabled).toBe(false)
      expect(config.whatsapp.enabled).toBe(false)
    })

    test("loads config from chat-bridge.json", () => {
      const configContent = {
        botName: "custom-bot",
        trigger: "!bot",
        rateLimitSeconds: 10
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.botName).toBe("custom-bot")
      expect(config.trigger).toBe("!bot")
      expect(config.rateLimitSeconds).toBe(10)
    })

    test("merges with defaults for partial config", () => {
      const configContent = {
        botName: "partial-bot"
        // Other fields should come from defaults
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.botName).toBe("partial-bot")
      expect(config.trigger).toBe("!oc") // From default
      expect(config.rateLimitSeconds).toBe(5) // From default
    })

    test("deep merges nested objects", () => {
      const configContent = {
        matrix: {
          enabled: true,
          homeserver: "https://custom.server.org"
          // Other matrix fields should come from defaults
        }
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.matrix.enabled).toBe(true)
      expect(config.matrix.homeserver).toBe("https://custom.server.org")
      expect(config.matrix.deviceId).toBe("OPENCODE_BRIDGE") // From default
      expect(config.matrix.autoJoin).toBe(true) // From default
    })

    test("loads from custom path", () => {
      const customPath = path.join(testDir, "custom-config.json")
      const configContent = { botName: "custom-path-bot" }
      fs.writeFileSync(customPath, JSON.stringify(configContent))

      const config = loadConfig(customPath)

      expect(config.botName).toBe("custom-path-bot")
    })

    test("substitutes environment variables", () => {
      process.env.TEST_BOT_NAME = "env-bot"
      process.env.TEST_TRIGGER = "!test"
      
      const configContent = {
        botName: "{env:TEST_BOT_NAME}",
        trigger: "{env:TEST_TRIGGER}"
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.botName).toBe("env-bot")
      expect(config.trigger).toBe("!test")
    })

    test("substitutes undefined env vars as empty string", () => {
      delete process.env.UNDEFINED_VAR
      
      const configContent = {
        botName: "{env:UNDEFINED_VAR}"
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.botName).toBe("")
    })

    test("substitutes env vars in nested objects", () => {
      process.env.MATRIX_SERVER = "https://env-server.org"
      
      const configContent = {
        matrix: {
          homeserver: "{env:MATRIX_SERVER}"
        }
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.matrix.homeserver).toBe("https://env-server.org")
    })

    test("substitutes env vars in arrays", () => {
      process.env.ALLOWED_NUM = "1234567890"
      
      const configContent = {
        whatsapp: {
          allowedNumbers: ["{env:ALLOWED_NUM}", "0987654321"]
        }
      }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config = loadConfig()

      expect(config.whatsapp.allowedNumbers).toContain("1234567890")
      expect(config.whatsapp.allowedNumbers).toContain("0987654321")
    })
  })

  describe("getConfig", () => {
    test("returns same config on multiple calls (caching)", () => {
      const configContent = { botName: "cached-bot" }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent)
      )
      process.chdir(testDir)

      const config1 = getConfig()
      const config2 = getConfig()

      expect(config1).toBe(config2) // Same object reference
    })
  })

  describe("clearConfigCache", () => {
    test("allows reloading config", () => {
      // Load initial config
      const configContent1 = { botName: "first-bot" }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent1)
      )
      process.chdir(testDir)

      const config1 = loadConfig()
      expect(config1.botName).toBe("first-bot")

      // Change config file and clear cache
      const configContent2 = { botName: "second-bot" }
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        JSON.stringify(configContent2)
      )
      clearConfigCache()

      const config2 = loadConfig()
      expect(config2.botName).toBe("second-bot")
    })
  })

  describe("error handling", () => {
    test("handles invalid JSON gracefully", () => {
      fs.writeFileSync(
        path.join(testDir, "chat-bridge.json"),
        "{ invalid json }"
      )
      process.chdir(testDir)

      // Should return defaults instead of throwing
      const config = loadConfig()
      expect(config.botName).toBe("oc")
    })
  })
})
