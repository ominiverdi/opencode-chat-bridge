import { createOpencodeClient } from '@opencode-ai/sdk'

const opencode = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' })

async function main() {
  // Create a session
  const session = await opencode.session.create({
    body: { title: 'Explicit Tools Test' }
  })
  console.log('Session:', session.data?.id)
  
  // Try with explicit MCP tool names using the mcp__server__tool pattern
  console.log('\nTrying with explicit MCP tools...')
  const result = await opencode.session.prompt({
    path: { id: session.data?.id! },
    body: {
      parts: [{ type: 'text', text: 'List the documents in the library.' }],
      agent: 'serious',
      tools: {
        'mcp__doclibrary__list_documents': true,
        'mcp__doclibrary__search_documents': true,
        'mcp__doclibrary__get_document_info': true,
      }
    }
  })
  
  const parts = result.data?.parts || []
  console.log('\nResponse parts:', parts.length)
  for (const p of parts) {
    console.log(`  Type: ${p.type}`)
    if (p.type === 'text') {
      console.log(`  Text: ${p.text?.slice(0, 800)}`)
    }
    if (p.type === 'tool-invocation') {
      console.log(`  Tool call: ${JSON.stringify(p)}`)
    }
  }
}

main().catch(console.error)
