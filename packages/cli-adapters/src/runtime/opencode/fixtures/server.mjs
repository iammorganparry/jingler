#!/usr/bin/env node
// SDK 1.18.14 HTTP/SSE contract fixture; never reads provider credentials.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const scenario = process.env.XDG_CACHE_HOME ?? ''
if (process.argv.includes('--version')) {
  console.log(scenario === 'unsupported' ? '0.1.0' : '1.18.14')
  process.exit(0)
}
if (scenario === 'memory-transport') { await new Promise(() => setInterval(() => {}, 1000)) }
const clients = new Set()
const pending = new Map()
const home = join(process.env.HOME, '.jingler-opencode-fixture')
mkdirSync(home, { recursive: true })
const emit = (directory, type, properties) => {
  const payload = { id: randomUUID(), type, properties }
  for (const response of clients) response.write(`data: ${JSON.stringify({ directory, payload })}\n\n`)
}
const model = (providerID) => ({ id: 'fixture-model', providerID, name: `OpenCode ${providerID}`, status: 'active', limit: { context: 128000, output: 8192 }, capabilities: { input: { image: true } } })
const providers = ['alpha', 'beta'].map(id => ({ id, name: id, models: { 'fixture-model': model(id) } }))
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: deterministic fixture enumerates independent protocol routes.
const server = createServer(async (request, response) => {
  const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
  const expected = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`
  if (!process.env.OPENCODE_SERVER_PASSWORD || request.headers.authorization !== expected) return json({}, 401)
  const url = new URL(request.url, 'http://localhost')
  const directory = url.searchParams.get('directory') ?? request.headers['x-opencode-directory'] ?? ''
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  if (url.pathname === '/global/health') return json({ healthy: scenario !== 'unhealthy', version: '1.18.14' })
  if (url.pathname === '/provider') return json({ all: providers, connected: scenario === 'signed-out' ? [] : ['alpha', 'beta'], default: {} })
  if (url.pathname === '/config/providers') return json({ providers, default: {} })
  if (url.pathname === '/global/event') {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    clients.add(response)
    response.write(`data: ${JSON.stringify({ directory: 'global', payload: { id: randomUUID(), type: 'server.connected', properties: {} } })}\n\n`)
    request.on('close', () => clients.delete(response))
    return
  }
  const save = (session) => { writeFileSync(join(home, session.id), JSON.stringify(session)); return session }
  if (url.pathname === '/session' && request.method === 'POST') return json(save({ id: `ses_${randomUUID()}`, directory, permission: body.permission }))
  if (url.pathname === '/session/status') return json({})
  const match = /^\/session\/(ses_[\w-]+)(?:\/(.*))?$/.exec(url.pathname)
  if (match) {
    const [, id, action] = match
    let session
    try { session = JSON.parse(readFileSync(join(home, id), 'utf8')) } catch { return json({}, 404) }
    if (!action) return json(request.method === 'PATCH' ? save({ ...session, permission: body.permission }) : session)
    if (action === 'fork') return json(save({ ...session, id: `ses_${randomUUID()}` }))
    if (action === 'abort') { pending.delete(id); emit(directory, 'session.idle', { sessionID: id }); return json(true) }
    if (action === 'prompt_async') {
      response.writeHead(204); response.end()
      const prompt = body.parts[0].text
      const messageID = `msg_${randomUUID()}`
      const finish = (reply = '') => {
        emit(directory, 'message.updated', { sessionID: id, info: { id: messageID, sessionID: id, role: 'assistant', parentID: body.messageID, modelID: body.model.modelID, providerID: body.model.providerID, agent: 'build', mode: 'build', path: { cwd: directory, root: directory }, time: { created: Date.now() }, cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } })
        emit(directory, 'message.part.updated', { sessionID: id, time: Date.now(), part: { id: `prt_${messageID}`, sessionID: id, messageID, type: 'text', text: `OpenCode: ${prompt}${reply}`, time: { start: 1, end: 2 } } })
        emit(directory, 'session.idle', { sessionID: id })
      }
      if (prompt === 'disconnect') { for (const client of clients) client.end(); return }
      if (prompt === 'wait') return
      if (prompt === 'permission') {
        pending.set(id, finish)
        emit(directory, 'permission.asked', { id, sessionID: id, permission: 'bash', patterns: ['echo ok'], always: [], metadata: {}, tool: { messageID, callID: 'tool-1' } })
        return
      }
      setTimeout(finish, 20)
      return
    }
  }
  const permission = /^\/permission\/(ses_[\w-]+)\/reply$/.exec(url.pathname)
  if (permission) { const finish = pending.get(permission[1]); pending.delete(permission[1]); json(true); finish?.(` ${body.reply}`); return }
  json({}, 404)
})
server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1')
