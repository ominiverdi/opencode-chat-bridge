import { createOpencodeClient } from '@opencode-ai/sdk'

const opencode = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' })

async function main() {
  const session = await opencode.session.create({
    body: { title: 'Streaming Test' }
  })
  console.log('Session:', session.data?.id)
  
  // Try with SSE streaming - maybe tools work differently
  console.log('\nTrying SSE streaming endpoint...')
  
  const response = await fetch('http://127.0.0.1:4096/session/' + session.data?.id + '/prompt/async', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'Use the list_documents tool to show documents in the library.' }],
      agent: 'serious',
    })
  })
  
  console.log('Response status:', response.status)
  console.log('Content-Type:', response.headers.get('content-type'))
  
  // Read SSE stream
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let fullText = ''
  
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    fullText += chunk
    
    // Parse SSE events
    const lines = chunk.split('\n')
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6))
          if (data.type === 'tool-invocation') {
            console.log('TOOL CALL:', data.name, data.args)
          } else if (data.type === 'tool-result') {
            console.log('TOOL RESULT:', JSON.stringify(data).slice(0, 200))
          } else if (data.type === 'text') {
            // Show first bit of text
            if (data.text?.length > 0) console.log('TEXT:', data.text.slice(0, 100))
          }
        } catch {}
      }
    }
  }
  
  console.log('\n--- Full response length:', fullText.length)
}

main().catch(console.error)
