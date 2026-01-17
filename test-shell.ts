import { createOpencodeClient } from '@opencode-ai/sdk'

const opencode = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' })

async function main() {
  const session = await opencode.session.create({ body: { title: 'Shell Test' } })
  console.log('Session:', session.data?.id)
  
  // Try shell endpoint instead of prompt
  console.log('\nTrying shell endpoint...')
  try {
    const result = await opencode.session.shell({
      path: { id: session.data?.id! },
      body: {
        command: 'What time is it? Use get_current_time.',
      }
    })
    console.log('Shell result:', JSON.stringify(result.data, null, 2))
  } catch (e) {
    console.log('Shell error:', e)
  }
  
  // Try command endpoint
  console.log('\nTrying command endpoint...')
  try {
    const result = await opencode.session.command({
      path: { id: session.data?.id! },
      body: {
        command: 'mcp',
        args: ['list'],
      }
    })
    console.log('Command result:', JSON.stringify(result.data, null, 2))
  } catch (e) {
    console.log('Command error:', e)
  }
}

main().catch(console.error)
