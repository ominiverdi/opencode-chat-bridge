/**
 * Unit tests for Telegram attachment extraction
 * Tests the pure function exported from connectors/telegram.ts
 *
 * extractTelegramAttachments() must work without network access -- it
 * returns metadata only. Downloading and persistence are exercised
 * elsewhere (e.g. integration smoke-tests with a mocked fetch).
 */

import { describe, test, expect } from "bun:test"
import {
  extractTelegramAttachments,
  type TelegramAttachment,
} from "../../connectors/telegram"

// =============================================================================
// photo
// =============================================================================

describe("extractTelegramAttachments", () => {
  describe("photo", () => {
    test("returns the largest PhotoSize by file_size", () => {
      const message = {
        photo: [
          { file_id: "small", file_size: 100, width: 90, height: 80 },
          { file_id: "big", file_size: 9_000, width: 800, height: 600 },
          { file_id: "medium", file_size: 4_500, width: 320, height: 240 },
        ],
      }
      const atts = extractTelegramAttachments(message)
      expect(atts).toHaveLength(1)
      expect(atts[0].kind).toBe("photo")
      expect(atts[0].fileId).toBe("big")
      expect(atts[0].size).toBe(9_000)
      expect(atts[0].mimeType).toBe("image/jpeg")
    })

    test("falls back to the last entry when sizes are missing", () => {
      const message = {
        photo: [
          { file_id: "a", width: 90, height: 80 },
          { file_id: "b", width: 800, height: 600 },
          { file_id: "c", width: 320, height: 240 },
        ],
      }
      const atts = extractTelegramAttachments(message)
      expect(atts).toHaveLength(1)
      // Last entry is the largest variant; that's our fallback.
      expect(atts[0].fileId).toBe("c")
      expect(atts[0].size).toBeUndefined()
    })

    test("ignores empty photo arrays", () => {
      expect(extractTelegramAttachments({ photo: [] })).toEqual([])
      expect(extractTelegramAttachments({ photo: undefined })).toEqual([])
    })

    test("ignores photo entries without a file_id", () => {
      const message = { photo: [{ width: 100 }, { file_id: "good" }] }
      const atts = extractTelegramAttachments(message)
      expect(atts).toHaveLength(1)
      expect(atts[0].fileId).toBe("good")
    })
  })

  // =============================================================================
  // single-object kinds
  // =============================================================================

  describe("single-object kinds", () => {
    test("extracts document with file_name and mime_type", () => {
      const message = {
        document: {
          file_id: "doc-id",
          file_unique_id: "uniq",
          file_name: "report.pdf",
          mime_type: "application/pdf",
          file_size: 50_000,
        },
      }
      const atts = extractTelegramAttachments(message)
      expect(atts).toEqual([
        {
          kind: "document",
          fileId: "doc-id",
          fileName: "report.pdf",
          mimeType: "application/pdf",
          size: 50_000,
        },
      ])
    })

    test("extracts video using a default mime_type", () => {
      const message = {
        video: {
          file_id: "vid",
          file_name: "clip.mp4",
          file_size: 1_000_000,
          width: 1280,
          height: 720,
        },
      }
      const atts = extractTelegramAttachments(message)
      expect(atts).toEqual([
        {
          kind: "video",
          fileId: "vid",
          fileName: "clip.mp4",
          mimeType: "video/mp4",
          size: 1_000_000,
        },
      ])
    })

    test("extracts video_note without a file_name", () => {
      const message = {
        video_note: {
          file_id: "vnote",
          length: 320,
          duration: 10,
          file_size: 500_000,
        },
      }
      const atts = extractTelegramAttachments(message)
      expect(atts).toEqual([
        {
          kind: "video_note",
          fileId: "vnote",
          mimeType: "video/mp4",
          size: 500_000,
        },
      ])
    })

    test("extracts audio with file_name", () => {
      const message = {
        audio: {
          file_id: "aud",
          file_name: "song.mp3",
          mime_type: "audio/mpeg",
          file_size: 4_000_000,
          duration: 200,
        },
      }
      const atts = extractTelegramAttachments(message)
      expect(atts).toEqual([
        {
          kind: "audio",
          fileId: "aud",
          fileName: "song.mp3",
          mimeType: "audio/mpeg",
          size: 4_000_000,
        },
      ])
    })

    test("extracts voice with default mime_type", () => {
      const message = {
        voice: { file_id: "vo", duration: 5, file_size: 80_000 },
      }
      const atts = extractTelegramAttachments(message)
      expect(atts).toEqual([
        {
          kind: "voice",
          fileId: "vo",
          mimeType: "audio/ogg",
          size: 80_000,
        },
      ])
    })

    test("extracts animation and uses fallback mime_type", () => {
      const message = {
        animation: {
          file_id: "gif",
          file_name: "funny.gif",
          file_size: 600_000,
          width: 320,
          height: 240,
        },
      }
      const atts = extractTelegramAttachments(message)
      expect(atts).toEqual([
        {
          kind: "animation",
          fileId: "gif",
          fileName: "funny.gif",
          mimeType: "video/mp4",
          size: 600_000,
        },
      ])
    })

    test("uses explicit mime_type when provided for animation", () => {
      const message = {
        animation: {
          file_id: "gif",
          mime_type: "image/gif",
          file_size: 600_000,
        },
      }
      const atts = extractTelegramAttachments(message)
      expect(atts[0].mimeType).toBe("image/gif")
    })

    test("extracts sticker with image/webp default", () => {
      const message = {
        sticker: {
          file_id: "stk",
          width: 512,
          height: 512,
          file_size: 30_000,
        },
      }
      const atts = extractTelegramAttachments(message)
      expect(atts).toEqual([
        {
          kind: "sticker",
          fileId: "stk",
          mimeType: "image/webp",
          size: 30_000,
        },
      ])
    })

    test("ignores kinds that are present but missing file_id", () => {
      const message = {
        document: { file_name: "x.pdf" },
        photo: [],
      }
      expect(extractTelegramAttachments(message)).toEqual([])
    })
  })

  // =============================================================================
  // mixed / combined
  // =============================================================================

  describe("multiple attachments", () => {
    test("returns every attachment in a single pass", () => {
      const message = {
        photo: [
          { file_id: "p1", file_size: 1000 },
          { file_id: "p2", file_size: 9000 },
        ],
        document: {
          file_id: "d1",
          file_name: "x.pdf",
          mime_type: "application/pdf",
        },
      }
      const atts = extractTelegramAttachments(message)
      const byKind = atts.reduce(
        (acc, a) => ({ ...acc, [a.kind]: a }),
        {} as Record<string, TelegramAttachment>
      )
      expect(atts).toHaveLength(2)
      expect(byKind.photo.fileId).toBe("p2")
      expect(byKind.document.fileId).toBe("d1")
    })

    test("returns an empty array when the message has no media", () => {
      expect(
        extractTelegramAttachments({
          message_id: 1,
          text: "plain text",
        })
      ).toEqual([])
    })

    test("ignores malformed kinds (non-object values)", () => {
      expect(
        extractTelegramAttachments({
          document: "not-an-object",
          photo: null,
          video: 42,
        })
      ).toEqual([])
    })
  })
})
