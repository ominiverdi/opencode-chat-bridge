#!/usr/bin/env bun
/**
 * Quick test script to verify Matrix connection
 * Run: bun test-matrix.ts
 */

import * as sdk from 'matrix-js-sdk'

// Load config
const configFile = Bun.file('./chat-bridge.json')
const config = await configFile.json()

// Resolve env vars
const accessToken = config.matrix.accessToken.replace(
  /\{env:(\w+)\}/,
  (_: string, varName: string) => process.env[varName] ?? ''
)

console.log('Testing Matrix connection...')
console.log('Homeserver:', config.matrix.homeserver)
console.log('User ID:', config.matrix.userId)
console.log('Access token:', accessToken ? `${accessToken.slice(0, 10)}...` : 'NOT SET')

if (!accessToken) {
  console.error('ERROR: MATRIX_ACCESS_TOKEN environment variable not set')
  console.log('Run: export MATRIX_ACCESS_TOKEN=your_token_here')
  process.exit(1)
}

const client = sdk.createClient({
  baseUrl: config.matrix.homeserver,
  accessToken: accessToken,
  userId: config.matrix.userId,
})

try {
  // Test: Get user info (whoami)
  const whoami = await client.whoami()
  console.log('Authenticated as:', whoami.user_id)
  console.log('Device ID:', whoami.device_id)

  // Test: Get joined rooms
  const rooms = await client.getJoinedRooms()
  console.log('Joined rooms:', rooms.joined_rooms.length)
  
  for (const roomId of rooms.joined_rooms.slice(0, 5)) {
    try {
      const room = client.getRoom(roomId)
      console.log(`  - ${room?.name || roomId}`)
    } catch {
      console.log(`  - ${roomId}`)
    }
  }

  // Check if we're in the test room
  const testRoomAlias = '#osgeo-bot:matrix.org'
  try {
    const resolved = await client.getRoomIdForAlias(testRoomAlias)
    const isJoined = rooms.joined_rooms.includes(resolved.room_id)
    console.log(`\nTest room ${testRoomAlias}:`)
    console.log('  Room ID:', resolved.room_id)
    console.log('  Joined:', isJoined ? 'YES' : 'NO - need to join')
    
    if (!isJoined) {
      console.log('  To join, run in Element: /join #osgeo-bot:matrix.org')
      console.log('  Or invite the bot from Element')
    }
  } catch (e) {
    console.log(`\nTest room ${testRoomAlias}: Could not resolve (may not exist yet)`)
  }

  console.log('\nMatrix connection: OK')
  
} catch (error) {
  console.error('Matrix connection FAILED:', error)
  process.exit(1)
}
