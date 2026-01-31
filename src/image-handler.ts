/**
 * Image handling utilities for chat connectors
 * 
 * Extracts doclibrary image markers from responses and manages uploads
 * to different chat platforms via callbacks.
 */

import fs from "fs"
import { extractImagePaths, removeImageMarkers } from "./session-utils"

/**
 * Callback type for platform-specific image uploads
 */
export type ImageUploadCallback = (imagePath: string) => Promise<void>

/**
 * Handles image extraction and upload for chat connectors
 */
export class ImageHandler {
  /**
   * Process response buffers for images, upload them, and return cleaned text
   * 
   * Images are marked in tool results with:
   * [DOCLIBRARY_IMAGE]/path/to/file.png[/DOCLIBRARY_IMAGE]
   * 
   * @param responseBuffer - The LLM response text
   * @param toolResultsBuffer - Tool results (may contain image markers)
   * @param uploadFn - Platform-specific upload callback
   * @returns Cleaned response text with image markers removed
   */
  static async processResponse(
    responseBuffer: string,
    toolResultsBuffer: string,
    uploadFn: ImageUploadCallback
  ): Promise<string> {
    const uploadedPaths = new Set<string>()
    
    // Extract from tool results (primary source)
    const toolPaths = extractImagePaths(toolResultsBuffer)
    for (const imagePath of toolPaths) {
      if (fs.existsSync(imagePath)) {
        console.log(`[IMAGE] Uploading from tool result: ${imagePath}`)
        try {
          await uploadFn(imagePath)
          uploadedPaths.add(imagePath)
        } catch (err) {
          console.error(`[IMAGE] Upload failed: ${imagePath}`, err)
        }
      } else {
        console.warn(`[IMAGE] File not found: ${imagePath}`)
      }
    }
    
    // Extract from response (secondary source, model might echo path)
    const responsePaths = extractImagePaths(responseBuffer)
    for (const imagePath of responsePaths) {
      // Skip if already uploaded from tool results
      if (uploadedPaths.has(imagePath)) continue
      
      if (fs.existsSync(imagePath)) {
        console.log(`[IMAGE] Uploading from response: ${imagePath}`)
        try {
          await uploadFn(imagePath)
          uploadedPaths.add(imagePath)
        } catch (err) {
          console.error(`[IMAGE] Upload failed: ${imagePath}`, err)
        }
      }
    }
    
    // Return cleaned response
    return removeImageMarkers(responseBuffer)
  }
  
  /**
   * Process only tool results buffer for images
   * Use when you need to handle images separately from response text
   */
  static async processToolResults(
    toolResultsBuffer: string,
    uploadFn: ImageUploadCallback
  ): Promise<void> {
    const paths = extractImagePaths(toolResultsBuffer)
    for (const imagePath of paths) {
      if (fs.existsSync(imagePath)) {
        console.log(`[IMAGE] Uploading: ${imagePath}`)
        try {
          await uploadFn(imagePath)
        } catch (err) {
          console.error(`[IMAGE] Upload failed: ${imagePath}`, err)
        }
      } else {
        console.warn(`[IMAGE] File not found: ${imagePath}`)
      }
    }
  }
}
