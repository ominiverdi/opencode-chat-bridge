/**
 * Unit tests for image-handler.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"
import { ImageHandler, type ImageUploadCallback } from "../../src/image-handler"

describe("ImageHandler", () => {
  const testDir = path.join(os.tmpdir(), "image-handler-test-" + Date.now())
  let testImage1: string
  let testImage2: string

  beforeEach(() => {
    // Create test directory and fake image files
    fs.mkdirSync(testDir, { recursive: true })
    testImage1 = path.join(testDir, "image1.png")
    testImage2 = path.join(testDir, "image2.png")
    fs.writeFileSync(testImage1, "fake image data 1")
    fs.writeFileSync(testImage2, "fake image data 2")
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe("processResponse", () => {
    test("uploads images from tool results and returns clean text", async () => {
      const uploadedPaths: string[] = []
      const uploadFn: ImageUploadCallback = async (path) => {
        uploadedPaths.push(path)
      }

      const responseBuffer = "Here is the image you requested."
      const toolResultsBuffer = `[DOCLIBRARY_IMAGE]${testImage1}[/DOCLIBRARY_IMAGE]`

      const result = await ImageHandler.processResponse(
        responseBuffer,
        toolResultsBuffer,
        uploadFn
      )

      expect(uploadedPaths).toEqual([testImage1])
      expect(result).toBe("Here is the image you requested.")
    })

    test("uploads images from response buffer", async () => {
      const uploadedPaths: string[] = []
      const uploadFn: ImageUploadCallback = async (path) => {
        uploadedPaths.push(path)
      }

      const responseBuffer = `Check this [DOCLIBRARY_IMAGE]${testImage1}[/DOCLIBRARY_IMAGE] out`
      const toolResultsBuffer = ""

      const result = await ImageHandler.processResponse(
        responseBuffer,
        toolResultsBuffer,
        uploadFn
      )

      expect(uploadedPaths).toEqual([testImage1])
      expect(result).toBe("Check this  out")
    })

    test("deduplicates images found in both buffers", async () => {
      const uploadedPaths: string[] = []
      const uploadFn: ImageUploadCallback = async (path) => {
        uploadedPaths.push(path)
      }

      // Same image in both buffers
      const marker = `[DOCLIBRARY_IMAGE]${testImage1}[/DOCLIBRARY_IMAGE]`
      const responseBuffer = `Image: ${marker}`
      const toolResultsBuffer = marker

      const result = await ImageHandler.processResponse(
        responseBuffer,
        toolResultsBuffer,
        uploadFn
      )

      // Should only upload once
      expect(uploadedPaths).toEqual([testImage1])
      expect(result).toBe("Image:")
    })

    test("uploads multiple different images", async () => {
      const uploadedPaths: string[] = []
      const uploadFn: ImageUploadCallback = async (path) => {
        uploadedPaths.push(path)
      }

      const toolResultsBuffer = `
        [DOCLIBRARY_IMAGE]${testImage1}[/DOCLIBRARY_IMAGE]
        [DOCLIBRARY_IMAGE]${testImage2}[/DOCLIBRARY_IMAGE]
      `
      const responseBuffer = "Two images."

      const result = await ImageHandler.processResponse(
        responseBuffer,
        toolResultsBuffer,
        uploadFn
      )

      expect(uploadedPaths).toContain(testImage1)
      expect(uploadedPaths).toContain(testImage2)
      expect(uploadedPaths.length).toBe(2)
      expect(result).toBe("Two images.")
    })

    test("skips non-existent files", async () => {
      const uploadedPaths: string[] = []
      const uploadFn: ImageUploadCallback = async (path) => {
        uploadedPaths.push(path)
      }

      const toolResultsBuffer = `[DOCLIBRARY_IMAGE]/non/existent/file.png[/DOCLIBRARY_IMAGE]`
      const responseBuffer = "Image:"

      const result = await ImageHandler.processResponse(
        responseBuffer,
        toolResultsBuffer,
        uploadFn
      )

      expect(uploadedPaths).toEqual([])
      expect(result).toBe("Image:")
    })

    test("handles upload failures gracefully", async () => {
      const uploadFn: ImageUploadCallback = async (path) => {
        throw new Error("Upload failed")
      }

      const toolResultsBuffer = `[DOCLIBRARY_IMAGE]${testImage1}[/DOCLIBRARY_IMAGE]`
      const responseBuffer = "Image:"

      // Should not throw
      const result = await ImageHandler.processResponse(
        responseBuffer,
        toolResultsBuffer,
        uploadFn
      )

      expect(result).toBe("Image:")
    })

    test("returns clean response when no images", async () => {
      const uploadedPaths: string[] = []
      const uploadFn: ImageUploadCallback = async (path) => {
        uploadedPaths.push(path)
      }

      const responseBuffer = "Just plain text response."
      const toolResultsBuffer = "Some tool output without images."

      const result = await ImageHandler.processResponse(
        responseBuffer,
        toolResultsBuffer,
        uploadFn
      )

      expect(uploadedPaths).toEqual([])
      expect(result).toBe("Just plain text response.")
    })
  })

  describe("processToolResults", () => {
    test("uploads images from tool results", async () => {
      const uploadedPaths: string[] = []
      const uploadFn: ImageUploadCallback = async (path) => {
        uploadedPaths.push(path)
      }

      const toolResultsBuffer = `[DOCLIBRARY_IMAGE]${testImage1}[/DOCLIBRARY_IMAGE]`

      await ImageHandler.processToolResults(toolResultsBuffer, uploadFn)

      expect(uploadedPaths).toEqual([testImage1])
    })

    test("uploads multiple images", async () => {
      const uploadedPaths: string[] = []
      const uploadFn: ImageUploadCallback = async (path) => {
        uploadedPaths.push(path)
      }

      const toolResultsBuffer = `
        [DOCLIBRARY_IMAGE]${testImage1}[/DOCLIBRARY_IMAGE]
        [DOCLIBRARY_IMAGE]${testImage2}[/DOCLIBRARY_IMAGE]
      `

      await ImageHandler.processToolResults(toolResultsBuffer, uploadFn)

      expect(uploadedPaths.length).toBe(2)
    })

    test("skips non-existent files", async () => {
      const uploadedPaths: string[] = []
      const uploadFn: ImageUploadCallback = async (path) => {
        uploadedPaths.push(path)
      }

      await ImageHandler.processToolResults(
        `[DOCLIBRARY_IMAGE]/fake/path.png[/DOCLIBRARY_IMAGE]`,
        uploadFn
      )

      expect(uploadedPaths).toEqual([])
    })

    test("handles empty buffer", async () => {
      const uploadedPaths: string[] = []
      const uploadFn: ImageUploadCallback = async (path) => {
        uploadedPaths.push(path)
      }

      await ImageHandler.processToolResults("", uploadFn)

      expect(uploadedPaths).toEqual([])
    })
  })
})
