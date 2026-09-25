import { randomUUID } from "node:crypto"
import type { OpenCodeOptions } from "../server.js"

/** Socket-free HTTP responses still exercise the real generated SDK and SSE parser. */
export const fixtureTransport = () => {
  const sessions = new Map<string, { id: string; directory: string; permission: unknown }>()
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const pending = new Map<string, (reply?: string) => void>()
  const requests: Request[] = []
  const encoder = new TextEncoder()
  const emit = (directory: string, type: string, properties: unknown) => {
    const data = encoder.encode(`data: ${JSON.stringify({ directory, payload: { id: randomUUID(), type, properties } })}\n\n`)
    for (const stream of streams) stream.enqueue(data)
  }
  const providers = ['alpha', 'beta'].map(id => ({ id, name: id, models: { 'fixture-model': { id: 'fixture-model', providerID: id, name: `OpenCode ${id}`, status: 'active', limit: { context: 128000 }, capabilities: { input: { image: true } } } } }))
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: protocol fixture enumerates independent HTTP routes.
  const fetch: typeof globalThis.fetch = async input => {
    const request = input as Request
    requests.push(request.clone())
    if (!request.headers.get('authorization')?.startsWith('Basic ')) return new Response(null, { status: 401 })
    const url = new URL(request.url)
    const directory = url.searchParams.get('directory') ?? request.headers.get('x-opencode-directory') ?? ''
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
    const body = (request.body ? await request.json() : {}) as { permission: unknown; parts: { text: string }[]; messageID: string; reply: string; answers: string[][] }
    if (url.pathname === '/global/health') return json({ healthy: true, version: '1.18.14' })
    if (url.pathname === '/provider') return json({ all: providers, connected: ['alpha', 'beta'], default: {} })
    if (url.pathname === '/config/providers') return json({ providers, default: {} })
    if (url.pathname === '/global/event') {
      let controller: ReadableStreamDefaultController<Uint8Array>
      return new Response(new ReadableStream({
        start(c) { controller = c; streams.add(c); emit('global', 'server.connected', {}) },
        cancel() { streams.delete(controller) }
      }), { headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.pathname === '/session' && request.method === 'POST') {
      const session = { id: `ses_${randomUUID()}`, directory, permission: body.permission }
      sessions.set(session.id, session)
      return json(session)
    }
    if (url.pathname === '/session/status') return json({})
    const match = /^\/session\/(ses_[\w-]+)(?:\/(.*))?$/.exec(url.pathname)
    if (match) {
      const id = match[1]!
      const session = sessions.get(id)
      if (!session) return json({}, 404)
      if (!match[2]) return json(session)
      if (match[2] === 'fork') { const fork = { ...session, id: `ses_${randomUUID()}`, directory }; sessions.set(fork.id, fork); return json(fork) }
      if (match[2] === 'abort') { pending.delete(id); return json(true) }
      if (match[2] === 'prompt_async') {
        const prompt = body.parts[0]!.text
        const messageID = `msg_${randomUUID()}`
        const finish = (reply = '') => {
          emit(directory, 'message.updated', { sessionID: id, info: { id: messageID, sessionID: id, role: 'assistant', parentID: body.messageID, cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } })
          emit(directory, 'message.part.updated', { sessionID: id, part: { id: messageID, sessionID: id, messageID, type: 'text', text: `OpenCode: ${prompt}${reply}`, time: { start: 1, end: 2 } } })
          emit(directory, 'session.idle', { sessionID: id })
        }
        if (prompt === 'disconnect') { for (const stream of streams) stream.close(); streams.clear() }
        else if (prompt === 'permission') { pending.set(id, finish); emit(directory, 'permission.asked', { id, sessionID: id, permission: 'bash', patterns: [], always: [], metadata: {} }) }
        else if (prompt === 'question') { const requestID = `que_${randomUUID()}`; pending.set(requestID, finish); emit(directory, 'question.asked', { id: requestID, sessionID: id, questions: [{ header: 'Choice', question: 'Pick one', options: [{ label: 'One', description: 'First option' }], multiple: false, custom: true }] }) }
        else if (prompt !== 'wait') finish()
        return new Response(null, { status: 204 })
      }
    }
    const permission = /^\/permission\/(ses_[\w-]+)\/reply$/.exec(url.pathname)
    if (permission) { pending.get(permission[1]!)?.(` ${body.reply}`); pending.delete(permission[1]!); return json(true) }
    const question = /^\/question\/(que_[\w-]+)\/reply$/.exec(url.pathname)
    if (question) { pending.get(question[1]!)?.(` ${body.answers.flat().join(',')}`); pending.delete(question[1]!); return json(true) }
    return json({}, 404)
  }
  const options = (binary: string): OpenCodeOptions => ({ binary, port: async () => 54321, fetch,
    environment: { ...process.env, XDG_CACHE_HOME: 'memory-transport' } })
  return { fetch, options, requests, emit }
}
