#!/usr/bin/env node
// SDK 1.18.14 HTTP/SSE contract fixture; never reads provider credentials.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const scenario = process.env.XDG_CACHE_HOME ?? ''
if (process.argv.includes('--version')) { console.log(scenario === 'unsupported' ? '0.1.0' : '1.18.14'); process.exit(0) }
if (scenario === 'memory-transport') { await new Promise(() => setInterval(() => {}, 1000)) }
const clients = new Set()
const pending = new Map()
const relays = new Map()
const home = join(process.env.HOME, '.jingler-opencode-fixture')
mkdirSync(home, { recursive: true })
const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
const emit = (directory, type, properties) => {
  const payload = { id: randomUUID(), type, properties }
  for (const response of clients) response.write(`data: ${JSON.stringify({ directory, payload })}\n\n`)
}
const model = (providerID) => ({ id: 'fixture-model', providerID, name: `OpenCode ${providerID}`, status: 'active', limit: { context: 128000, output: 8192 }, capabilities: { input: { image: true } } })
const providers = ['alpha', 'beta'].map(id => ({ id, name: id, models: { 'fixture-model': model(id) } }))
const save = (session) => { writeFileSync(join(home, session.id), JSON.stringify(session)); return session }
const readSession = (id) => { try { return JSON.parse(readFileSync(join(home, id), 'utf8')) } catch { return null } }
const promptOutput = (directory, id, body, messageID, text) => {
  emit(directory, 'message.updated', { sessionID: id, info: { id: messageID, sessionID: id, role: 'assistant', parentID: body.messageID, modelID: body.model.modelID, providerID: body.model.providerID, agent: 'build', mode: 'build', path: { cwd: directory, root: directory }, time: { created: Date.now() }, cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } })
  emit(directory, 'message.part.updated', { sessionID: id, time: Date.now(), part: { id: `prt_${messageID}`, sessionID: id, messageID, type: 'text', text, time: { start: 1, end: 2 } } })
}
const finishPrompt = (directory, id, body, messageID, prompt, reply = '') => {
  promptOutput(directory, id, body, messageID, `OpenCode: ${prompt}${reply}`)
  emit(directory, 'session.idle', { sessionID: id })
}
const launchDetachedSubagent = async (directory, finish) => {
  const relay = relays.get(directory)
  if (!relay) throw new Error('OpenCode detached fixture has no Jingler relay')
  const response = await fetch(relay.url, {
    method: 'POST',
    headers: { ...relay.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'subagent',
        arguments: { async: true, agent: 'worker', task: 'Detached native worker e2e; remain active until stopped.' }
      }
    })
  })
  const message = await response.json()
  const envelope = JSON.parse(message.result?.content?.[0]?.text ?? 'null')
  if (envelope?.status !== 'running' || typeof envelope?.runId !== 'string') throw new Error('detached launch failed')
  finish()
}
const handlePrompt = (_request, response, directory, id, body) => {
  response.writeHead(204); response.end()
  body.messageID ??= `msg_${randomUUID()}`
  emit(directory, "message.updated", { info: { id: body.messageID, sessionID: id, role: "user" } })
  const prompt = body.parts[0].text
  const messageID = `msg_${randomUUID()}`
  const finish = (reply = '') => finishPrompt(directory, id, body, messageID, prompt, reply)
  if (prompt === 'disconnect') { for (const client of clients) client.end(); return }
  if (prompt.includes('resumed turn')) {
    promptOutput(directory, id, body, messageID, 'OpenCode: resumed turn')
    emit(directory, 'session.idle', { sessionID: id })
    return
  }
  if (prompt.includes('native first turn')) {
    promptOutput(directory, id, body, messageID, 'OpenCode: native first turn')
    emit(directory, 'session.idle', { sessionID: id })
    return
  }
  if (prompt.includes('Second retained OpenCode parent turn')) {
    promptOutput(directory, id, body, messageID, 'Native OpenCode second parent turn completed.')
    emit(directory, 'session.idle', { sessionID: id })
    return
  }
  if (prompt.includes('Launch the retained native workflow')) {
    const detachedFinish = () => {
      promptOutput(directory, id, body, messageID, 'Native OpenCode parent settled after detached launch.')
      emit(directory, 'session.idle', { sessionID: id })
    }
    launchDetachedSubagent(directory, detachedFinish).catch((error) => finish(` — detached launch failed: ${error.message}`))
    return
  }
  if (prompt.includes('Detached native worker e2e; remain active until stopped.')) {
    promptOutput(directory, id, body, messageID, 'Detached OpenCode child progress: waiting for stop.')
    return
  }
  if (prompt === 'wait') return
  if (prompt === 'permission') {
    pending.set(id, finish)
    emit(directory, 'permission.asked', { id, sessionID: id, permission: 'bash', patterns: ['echo ok'], always: [], metadata: {}, tool: { messageID, callID: 'tool-1' } })
    return
  }
  setTimeout(finish, 20)
}
const handleSession = (request, response, directory, body, match) => {
  const [, id, action] = match
  const session = readSession(id) ?? save({ id, directory, permission: body.permission })
  if (!action) { json(response, request.method === 'PATCH' ? save({ ...session, permission: body.permission }) : session); return }
  if (action === 'fork') { json(response, save({ ...session, id: `ses_${randomUUID()}` })); return }
  if (action === 'abort') { pending.delete(id); emit(directory, 'session.idle', { sessionID: id }); json(response, true); return }
  if (action === 'prompt_async') { handlePrompt(request, response, directory, id, body); return }
  json(response, {}, 404)
}
const readBody = async (request) => { let raw = ''; for await (const chunk of request) raw += chunk; return raw ? JSON.parse(raw) : {} }
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one compact HTTP fixture intentionally enumerates protocol routes.
const handleRequest = async (request, response) => {
  const expected = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`
  if (!process.env.OPENCODE_SERVER_PASSWORD || request.headers.authorization !== expected) { json(response, {}, 401); return }
  const url = new URL(request.url, 'http://localhost')
  const directory = url.searchParams.get('directory') ?? request.headers['x-opencode-directory'] ?? ''
  const body = await readBody(request)
  if (url.pathname === '/global/health') { json(response, { healthy: scenario !== 'unhealthy', version: '1.18.14' }); return }
  if (url.pathname === '/config') { json(response, { mcp: {} }); return }
  if (url.pathname === '/provider') { json(response, { all: providers, connected: scenario === 'signed-out' ? [] : ['alpha', 'beta'], default: {} }); return }
  if (url.pathname === '/config/providers') { json(response, { providers, default: {} }); return }
  if (url.pathname === '/global/event') {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); clients.add(response)
    response.write(`data: ${JSON.stringify({ directory: 'global', payload: { id: randomUUID(), type: 'server.connected', properties: {} } })}\n\n`)
    request.on('close', () => clients.delete(response)); return
  }
  if (url.pathname === '/mcp' && request.method === 'POST' && body.config) {
    relays.set(directory, body.config)
    json(response, { jingler: { status: 'connected' } })
    return
  }
  if (url.pathname === '/session' && request.method === 'POST') { json(response, save({ id: `ses_${randomUUID()}`, directory, permission: body.permission })); return }
  if (url.pathname === '/session/status') { json(response, {}); return }
  const session = /^\/session\/(ses_[\w-]+)(?:\/(.*))?$/.exec(url.pathname)
  if (session) { handleSession(request, response, directory, body, session); return }
  const permission = /^\/permission\/(ses_[\w-]+)\/reply$/.exec(url.pathname)
  if (permission) { const finish = pending.get(permission[1]); pending.delete(permission[1]); json(response, true); finish?.(` ${body.reply}`); return }
  json(response, {}, 404)
}
const server = createServer(handleRequest)
server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1')
