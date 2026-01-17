import { createOpencodeClient } from '@opencode-ai/sdk'

const opencode = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' })

async function main() {
  // Create a session
  const session = await opencode.session.create({
    body: { title: 'MCP Call Test' }
  })
  console.log('Session:', session.data?.id)
  
  // Send prompt asking to call the doclibrary tool
  console.log('\nSending prompt to call list_documents...')
  const result = await opencode.session.prompt({
    path: { id: session.data?.id! },
    body: {
      parts: [{ type: 'text', text: 'Use the list_documents tool to show me what documents are in the library. Do not make up or fabricate any information.' }],
      agent: 'serious',
    }
  })
  
  const parts = result.data?.parts || []
  console.log('\nResponse parts:', parts.length)
  for (const p of parts) {
    console.log(`  Type: ${p.type}`)
    if (p.type === 'text') {
      console.log(`  Text (first 500 chars): ${p.text?.slice(0, 500)}`)
    }
    if (p.type === 'tool-invocation') {
      console.log(`  Tool: ${(p as any).name}`)
      console.log(`  Args: ${JSON.stringify((p as any).args)}`)
    }
    if (p.type === 'tool-result') {
      console.log(`  Tool result: ${JSON.stringify((p as any).result)?.slice(0, 200)}`)
    }
  }
}

main().catch(console.error)
