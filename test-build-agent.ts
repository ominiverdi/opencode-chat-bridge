import { createOpencodeClient } from '@opencode-ai/sdk'

const opencode = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' })

async function main() {
  const session = await opencode.session.create({
    body: { title: 'Build Agent MCP Test' }
  })
  console.log('Session:', session.data?.id)
  
  // Test with BUILD agent (not our custom serious agent)
  console.log('\n--- Testing with BUILD agent ---')
  const result = await opencode.session.prompt({
    path: { id: session.data?.id! },
    body: {
      parts: [{ type: 'text', text: 'What time is it right now? Use the time tool.' }],
      // Use built-in agent, not custom
    }
  })
  
  const parts = result.data?.parts || []
  console.log('Response parts:', parts.length)
  for (const p of parts) {
    console.log(`  Type: ${p.type}`)
    if (p.type === 'text') console.log(`  Text: ${p.text?.slice(0, 300)}`)
    if (p.type === 'tool-invocation') console.log(`  TOOL CALL: ${JSON.stringify(p)}`)
    if (p.type === 'tool-result') console.log(`  TOOL RESULT: ${JSON.stringify(p).slice(0, 200)}`)
  }
}

main().catch(console.error)
