import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { randomUUID } from "node:crypto"
import type { OpenCodeOptions } from "../server.js"

interface FixtureBody { config?: { url: string; headers: Record<string, string>; timeout: number }; system?: string; permission: unknown; parts: { text: string }[]; messageID: string; reply: string; answers: string[][] }
type FixtureSession = { id: string; directory: string; permission: unknown }

/** Socket-free HTTP responses still exercise the real generated SDK and SSE parser. */
export const fixtureTransport = () => {
  const relays = new Map<string, NonNullable<FixtureBody["config"]>>()
  const sessions = new Map<string, FixtureSession>()
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const pending = new Map<string, (reply?: string) => void>()
  const requests: Request[] = []
  const encoder = new TextEncoder()
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
  const emit = (directory: string, type: string, properties: unknown) => {
    const data = encoder.encode(`data: ${JSON.stringify({ directory, payload: { id: randomUUID(), type, properties } })}\n\n`)
    for (const stream of streams) stream.enqueue(data)
  }
  const providers = ["alpha", "beta"].map(id => ({ id, name: id, models: { "fixture-model": { id: "fixture-model", providerID: id, name: `OpenCode ${id}`, status: "active", limit: { context: 128000 }, capabilities: { input: { image: true } } } } }))
  const finishPrompt = (directory: string, id: string, parentID: string, messageID: string, prompt: string, reply = "") => {
    emit(directory, "message.updated", { sessionID: id, info: { id: messageID, sessionID: id, role: "assistant", parentID, cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } })
    emit(directory, "message.part.updated", { sessionID: id, part: { id: messageID, sessionID: id, messageID, type: "text", text: `OpenCode: ${prompt}${reply}`, time: { start: 1, end: 2 } } })
    emit(directory, "session.idle", { sessionID: id })
  }
  const probeRelay = async (server: string, prompt: string, system: string | undefined, finish: (reply: string) => void) => {
    const relay = relays.get(server)!
    const client = new Client({ name: "opencode-fixture", version: "1" })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(relay.url), { requestInit: { headers: relay.headers } }))
      const listed = await client.listTools()
      if (relay.timeout !== 86_400_000) throw new Error("Interactive relay timeout is missing")
      const planning = prompt.startsWith("planning-probe")
      if (planning) await client.callTool({ name: "plannotator_update_plan", arguments: { filePath: "plan.md" } })
      const result = await client.callTool(planning ? { name: "plannotator_submit_plan", arguments: { filePath: "plan.md" } } : { name: "probe_echo", arguments: {} })
      finish(JSON.stringify({ names: listed.tools.map(t => t.name), output: result.content, inherited: system?.includes("jingler.identity-and-safety") }))
    } finally { await client.close() }
  }
  const handlePrompt = async (directory: string, id: string, body: FixtureBody, server: string) => {
    body.messageID ??= `msg_${randomUUID()}`
    emit(directory, "message.updated", { info: { id: body.messageID, sessionID: id, role: "user" } })
    const prompt = body.parts[0]!.text
    const messageID = `msg_${randomUUID()}`
    const finish = (reply = "") => finishPrompt(directory, id, body.messageID, messageID, prompt, reply)
    if (prompt === "registry-probe" || prompt.startsWith("planning-probe")) {
      await probeRelay(server, prompt, body.system, finish)
    }
    else if (prompt === "disconnect") { for (const stream of streams) stream.close(); streams.clear() }
    else if (prompt === "permission") { pending.set(id, finish); emit(directory, "permission.asked", { id, sessionID: id, permission: "bash", patterns: [], always: [], metadata: {} }) }
    else if (prompt === "question") { const requestID = `que_${randomUUID()}`; pending.set(requestID, finish); emit(directory, "question.asked", { id: requestID, sessionID: id, questions: [{ header: "Choice", question: "Pick one", options: [{ label: "One", description: "First option" }], multiple: false, custom: true }] }) }
    else if (prompt !== "wait") finish()
    return new Response(null, { status: 204 })
  }
  const handleSession = (match: RegExpExecArray, directory: string, body: FixtureBody, server: string) => {
    const id = match[1]!
    const session = sessions.get(id)
    if (!session) return json({}, 404)
    if (!match[2]) return json(session)
    if (match[2] === "fork") { const fork = { ...session, id: `ses_${randomUUID()}`, directory }; sessions.set(fork.id, fork); return json(fork) }
    if (match[2] === "abort") { pending.delete(id); return json(true) }
    if (match[2] === "prompt_async") return handlePrompt(directory, id, body, server)
    return json({}, 404)
  }
  const globalResponse = (url: URL): Response | null => {
    if (url.pathname === "/global/health") return json({ healthy: true, version: "1.18.14" })
    if (url.pathname === "/config") return json({})
    if (url.pathname === "/provider") return json({ all: providers, connected: ["alpha", "beta"], default: {} })
    if (url.pathname === "/config/providers") return json({ providers, default: {} })
    if (url.pathname !== "/global/event") return null
    let controller: ReadableStreamDefaultController<Uint8Array>
    return new Response(new ReadableStream({ start(c) { controller = c; streams.add(c); emit("global", "server.connected", {}) }, cancel() { streams.delete(controller) } }), { headers: { "content-type": "text/event-stream" } })
  }
  const replyResponse = (url: URL, body: FixtureBody): Response | null => {
    const permission = /^\/permission\/(ses_[\w-]+)\/reply$/.exec(url.pathname)
    if (permission) { pending.get(permission[1]!)?.(` ${body.reply}`); pending.delete(permission[1]!); return json(true) }
    const question = /^\/question\/(que_[\w-]+)\/reply$/.exec(url.pathname)
    if (!question) return null
    pending.get(question[1]!)?.(` ${body.answers.flat().join(",")}`)
    pending.delete(question[1]!)
    return json(true)
  }
  const mcpResponse = (url: URL, request: Request, body: FixtureBody): Response | null => {
    if (url.pathname !== "/mcp" || request.method !== "POST" || !body.config) return null
    relays.set(request.headers.get("authorization")!, body.config)
    return json({ jingler: { status: "connected" } })
  }
  const fetch: typeof globalThis.fetch = async input => {
    const request = input as Request
    requests.push(request.clone())
    if (!request.headers.get("authorization")?.startsWith("Basic ")) return new Response(null, { status: 401 })
    const url = new URL(request.url)
    const directory = url.searchParams.get("directory") ?? request.headers.get("x-opencode-directory") ?? ""
    const body = (request.body ? await request.json() : {}) as FixtureBody
    const global = globalResponse(url)
    if (global) return global
    if (url.pathname === "/session" && request.method === "POST") { const session = { id: `ses_${randomUUID()}`, directory, permission: body.permission }; sessions.set(session.id, session); return json(session) }
    if (url.pathname === "/session/status") return json({})
    const session = /^\/session\/(ses_[\w-]+)(?:\/(.*))?$/.exec(url.pathname)
    if (session) return handleSession(session, directory, body, request.headers.get("authorization")!)
    return mcpResponse(url, request, body) ?? replyResponse(url, body) ?? json({}, 404)
  }
  const options = (binary: string): OpenCodeOptions => ({ binary, port: async () => 54321, fetch, environment: { ...process.env, XDG_CACHE_HOME: "memory-transport" } })
  return { fetch, options, requests, emit }
}
