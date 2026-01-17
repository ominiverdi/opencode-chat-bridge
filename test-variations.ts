import { createOpencodeClient } from '@opencode-ai/sdk'

const opencode = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' })

async function testPrompt(name: string, body: any) {
  const session = await opencode.session.create({ body: { title: name } })
  console.log(`\n=== ${name} (session: ${session.data?.id}) ===`)
  
  const result = await opencode.session.prompt({
    path: { id: session.data?.id! },
    body
  })
  
  const parts = result.data?.parts || []
  for (const p of parts) {
    if (p.type === 'tool-invocation') console.log(`TOOL CALL: ${JSON.stringify(p)}`)
    if (p.type === 'tool-result') console.log(`TOOL RESULT: ${JSON.stringify(p).slice(0, 300)}`)
    if (p.type === 'text' && p.text) console.log(`TEXT: ${p.text.slice(0, 200)}...`)
  }
}

async function main() {
  // Test 1: No agent specified
  await testPrompt('No agent', {
    parts: [{ type: 'text', text: 'What time is it? Use get_current_time tool.' }],
  })
  
  // Test 2: Explicit 'build' agent
  await testPrompt('Build agent', {
    parts: [{ type: 'text', text: 'What time is it? Use get_current_time tool.' }],
    agent: 'build',
  })
  
  // Test 3: With providerID/modelID instead of agent
  await testPrompt('With model directly', {
    parts: [{ type: 'text', text: 'What time is it? Use get_current_time tool.' }],
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-20250514',
  })
  
  // Test 4: doclibrary with no agent
  await testPrompt('Doclibrary no agent', {
    parts: [{ type: 'text', text: 'List documents in the library using list_documents tool.' }],
  })
}

main().catch(console.error)
