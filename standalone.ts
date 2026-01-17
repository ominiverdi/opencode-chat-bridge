#!/usr/bin/env bun
/**
 * Standalone Matrix-OpenCode Bridge
 * 
 * Runs independently and connects to an OpenCode server via HTTP API.
 * This is simpler than the plugin approach and easier to debug.
 * 
 * Usage:
 *   Terminal 1: opencode serve --port 4096
 *   Terminal 2: bun standalone.ts
 */

import * as sdk from 'matrix-js-sdk'
import { createOpencodeClient } from '@opencode-ai/sdk'

// Configuration
const OPENCODE_URL = process.env.OPENCODE_URL || 'http://127.0.0.1:4096'
const MATRIX_HOMESERVER = 'https://matrix.org'
const MATRIX_USER_ID = '@llm-assitant:matrix.org'
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN

// Trigger patterns
const TRIGGER_PATTERNS = ['@llm-assitant:', '!oc ']

// Default agent (always used unless overridden by mode command)
const DEFAULT_AGENT = 'serious'

// Mode mappings
const MODES: Record<string, string> = {
  '!s': 'serious',
  '!d': 'sarcastic',
  '!a': 'agent',
  '!p': 'plan',
}

if (!MATRIX_ACCESS_TOKEN) {
  console.error('ERROR: MATRIX_ACCESS_TOKEN not set')
  process.exit(1)
}

// Session mapping (roomId -> sessionId)
const sessions = new Map<string, string>()

// Initialize OpenCode client
console.log(`Connecting to OpenCode at ${OPENCODE_URL}...`)
const opencode = createOpencodeClient({ baseUrl: OPENCODE_URL })

// Test OpenCode connection by listing sessions
try {
  const sessions_result = await opencode.session.list()
  const count = sessions_result.data ? Object.keys(sessions_result.data).length : 0
  console.log(`OpenCode connected (${count} existing sessions)`)
} catch (e) {
  console.error('Failed to connect to OpenCode:', e)
  console.log('Make sure to run: opencode serve --port 4096')
  process.exit(1)
}

// Initialize Matrix client
console.log(`Connecting to Matrix as ${MATRIX_USER_ID}...`)
const matrix = sdk.createClient({
  baseUrl: MATRIX_HOMESERVER,
  accessToken: MATRIX_ACCESS_TOKEN,
  userId: MATRIX_USER_ID,
})

// Check if message is directed at us
function isDirectedAtUs(content: string): boolean {
  for (const pattern of TRIGGER_PATTERNS) {
    if (content.includes(pattern)) return true
  }
  if (content.includes(MATRIX_USER_ID)) return true
  return false
}

// Strip trigger patterns from content
function stripTrigger(content: string): string {
  let result = content
  for (const pattern of TRIGGER_PATTERNS) {
    result = result.replace(pattern, '').trim()
  }
  result = result.replace(MATRIX_USER_ID, '').trim()
  return result
}

// Parse mode from message
function parseMode(content: string): { content: string; agent?: string } {
  const trimmed = content.trim()
  for (const [prefix, agent] of Object.entries(MODES)) {
    if (trimmed.startsWith(prefix + ' ') || trimmed === prefix) {
      return { content: trimmed.slice(prefix.length).trim(), agent }
    }
  }
  return { content: trimmed }
}

// Handle incoming Matrix messages
matrix.on('Room.timeline', async (event: any, room: any) => {
  // Only handle text messages
  if (event.getType() !== 'm.room.message') return
  
  // Ignore our own messages
  if (event.getSender() === MATRIX_USER_ID) return
  
  const content = event.getContent()
  const body = content.body
  if (!body) return
  
  // Check if directed at us
  if (!isDirectedAtUs(body)) return
  
  const roomId = room.roomId
  const sender = event.getSender()
  console.log(`[${roomId}] ${sender}: ${body.slice(0, 50)}...`)
  
  // Strip trigger and parse mode
  const stripped = stripTrigger(body)
  const { content: prompt, agent } = parseMode(stripped)
  
  if (!prompt) {
    console.log('Empty prompt, ignoring')
    return
  }
  
  // Show typing indicator
  await matrix.sendTyping(roomId, true, 30000)
  
  try {
    // Get or create session
    let sessionId = sessions.get(roomId)
    if (!sessionId) {
      const roomName = room.name || roomId.slice(0, 20)
      console.log(`Creating new session for room: ${roomName}`)
      
      const session = await opencode.session.create({
        body: { title: `Matrix: ${roomName}` }
      })
      sessionId = session.data?.id
      if (sessionId) {
        sessions.set(roomId, sessionId)
        console.log(`Created session: ${sessionId}`)
      }
    }
    
    if (!sessionId) {
      throw new Error('Failed to create session')
    }
    
    const selectedAgent = agent || DEFAULT_AGENT
    console.log(`Sending prompt to session ${sessionId} (agent: ${selectedAgent})`)
    
    // Send prompt to OpenCode (always use an agent)
    const result = await opencode.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        agent: selectedAgent,
      }
    })
    
    // Extract text response
    const parts = result.data?.parts || []
    const textParts = parts
      .filter((p: any) => p.type === 'text' && p.text)
      .map((p: any) => p.text)
    
    const response = textParts.join('\n\n') || 'No response generated.'
    
    // Stop typing and send response
    await matrix.sendTyping(roomId, false)
    
    // Split long messages
    const maxLen = 4000
    if (response.length <= maxLen) {
      await matrix.sendMessage(roomId, {
        msgtype: 'm.text',
        body: response,
        format: 'org.matrix.custom.html',
        formatted_body: response,
      })
    } else {
      // Split into chunks
      const chunks = response.match(new RegExp(`.{1,${maxLen}}`, 'gs')) || []
      for (let i = 0; i < chunks.length; i++) {
        const chunk = i === 0 ? chunks[i] : `(${i + 1}/${chunks.length}) ${chunks[i]}`
        await matrix.sendMessage(roomId, {
          msgtype: 'm.text',
          body: chunk,
        })
      }
    }
    
    console.log(`Response sent (${response.length} chars)`)
    
  } catch (error) {
    console.error('Error processing message:', error)
    await matrix.sendTyping(roomId, false)
    await matrix.sendMessage(roomId, {
      msgtype: 'm.text',
      body: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
})

// Handle sync state
matrix.on('sync', (state: string) => {
  if (state === 'PREPARED') {
    console.log('Matrix sync complete, ready to receive messages!')
    console.log('Trigger patterns:', TRIGGER_PATTERNS.join(', '))
    console.log('Mode commands:', Object.keys(MODES).join(', '))
  }
})

// Start Matrix client
console.log('Starting Matrix client...')
await matrix.startClient({ initialSyncLimit: 10 })

console.log('Bridge running. Press Ctrl+C to stop.')
