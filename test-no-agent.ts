import { createOpencodeClient } from '@opencode-ai/sdk'

const opencode = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' })

async function main() {
  const session = await opencode.session.create({
    body: { title: 'No Agent Test' }
  })
  console.log('Session:', session.data?.id)
  
  // NO agent specified - should use OpenCode's true default
  const result = await opencode.session.prompt({
    path: { id: session.data?.id! },
    body: {
      parts: [{ type: 'text', text: 'What time is it in Copenhagen?' }],
      // NO agent parameter!
    }
  })
  
  const parts = result.data?.parts || []
  console.log('Response parts:', parts.length)
  for (const p of parts) {
    console.log(`Type: ${p.type}`)
    if (p.type === 'text') console.log(`Text: ${p.text}`)
    if (p.type === 'tool-invocation') console.log(`TOOL: ${JSON.stringify(p)}`)
    if (p.type === 'tool-result') console.log(`RESULT: ${JSON.stringify(p)}`)
  }
}

main().catch(console.error)
