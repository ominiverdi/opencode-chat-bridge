import { createOpencodeClient } from '@opencode-ai/sdk'

const opencode = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' })

async function main() {
  // Create a session
  const session = await opencode.session.create({
    body: { title: 'MCP Tool Test' }
  })
  console.log('Session:', session.data?.id)
  
  // Get session info
  const info = await opencode.session.get({ path: { id: session.data?.id! } })
  console.log('Session info:', JSON.stringify(info.data, null, 2))
  
  // Try listing tools  
  const toolsResp = await fetch('http://127.0.0.1:4096/experimental/tool')
  console.log('Tools endpoint status:', toolsResp.status)
  
  // Send a simple prompt asking for tools
  const result = await opencode.session.prompt({
    path: { id: session.data?.id! },
    body: {
      parts: [{ type: 'text', text: 'List all tools you have available. Just list their names, nothing else.' }],
      agent: 'serious',
    }
  })
  
  const parts = result.data?.parts || []
  for (const p of parts) {
    if (p.type === 'text') console.log('Response:', p.text?.slice(0, 2000))
    if (p.type === 'tool-invocation') console.log('Tool call:', p.name)
  }
}

main().catch(console.error)
