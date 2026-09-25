import { spawn } from "node:child_process"
import { fixtureTransport } from "./fixtures/transport.js"
import { fileURLToPath } from "node:url"
import { realpath } from "node:fs/promises"
import { AgentEndpointCatalogEntry, CURRENT_RUNTIME_CONTRACTS, nativeCliEndpointId, ProviderId, ProviderModelId, type AgentRunSpec } from "@jingler/core"
import { Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { liveChildCount } from "../../child-registry.js"
import { inactiveRuntimeActivity } from "../agent/agent-runtime.js"
import { probeOpenCodeEndpoint } from "./endpoint.js"
import { OpenCodeServer, boundedResponse, makeOpenCodePool, openCodeEnvironment } from "./server.js"
import { makeOpenCodeAgentRuntime, openOpenCodeSession } from "./runtime.js"

const binary = fileURLToPath(new URL("./fixtures/server.mjs", import.meta.url))
const endpointId = nativeCliEndpointId("desktop", "opencode")
const spec = (over: Partial<AgentRunSpec> = {}): AgentRunSpec => ({
  runId: "run", sessionId: "session", chatId: "chat", runtimeId: "opencode", endpointId,
  providerId: ProviderId.make("alpha"), modelId: ProviderModelId.make("fixture-model"), role: "conversation",
  mode: "auto", cwd: "/tmp", prompt: "hello", priorMessages: [], continuation: null, seed: null,
  targetCapabilities: { versions: CURRENT_RUNTIME_CONTRACTS, toolIds: [], resourceIds: [], targetId: "desktop" }, ...over
})
const context = { ...inactiveRuntimeActivity, canUseTool: () => Effect.succeed("deny" as const), askQuestion: () => Effect.succeed([]) }
const transport = fixtureTransport()
const options = transport.options(binary)
const runtime = () => makeOpenCodeAgentRuntime(options)
const collect = (input = spec(), instance = runtime()) => Effect.runPromise(instance.run(input, context).pipe(Stream.runCollect)).then(events => Array.from(events))

describe("native OpenCode 1.18.14", () => {
  it("discovers two providers with overlapping model IDs under one target-local endpoint", async () => {
    const entry = await probeOpenCodeEndpoint({ ...options, targetId: "device-1" })
    Schema.decodeUnknownSync(AgentEndpointCatalogEntry)(entry)
    expect(entry.endpoint).toMatchObject({ id: "device-1:opencode:default", status: "ready" })
    expect(entry.models.map(m => [m.providerId, m.id])).toEqual([["alpha", "fixture-model"], ["beta", "fixture-model"]])
    expect(liveChildCount()).toBe(0)
  })
  it.each([['signed-out', 'signed-out'], ['unsupported', 'unsupported'], ['unhealthy', 'unsupported']])("reports %s without leaking processes", async (scenario, status) => {
    expect((await probeOpenCodeEndpoint({ ...options, environment: { ...process.env, XDG_CACHE_HOME: scenario === 'unsupported' ? scenario : 'memory-transport' }, fetch: async input => { const request = input as Request; if (scenario === 'signed-out' && request.url.endsWith('/provider')) return Response.json({ all: [], connected: [], default: {} }); if (scenario === 'unhealthy' && request.url.endsWith('/global/health')) return Response.json({ healthy: false, version: '1.18.14' }); return transport.fetch(input) } })).endpoint.status).toBe(status)
    expect(liveChildCount()).toBe(0)
  })
  it("reports a missing binary", async () => {
    expect((await probeOpenCodeEndpoint({ binary: '/nonexistent/opencode' })).endpoint.status).toBe('missing')
  })
  it("streams nested message events and resumes after the owned server restarts", async () => {
    const first = await collect()
    expect(first).toContainEqual({ _tag: "Assistant", text: "OpenCode: hello" })
    expect(first.at(-1)).toEqual({ _tag: "Done", tokens: 15, costUsd: 0.01 })
    const started = first.find(e => e._tag === 'Started')!
    if (started._tag !== 'Started') throw new Error('missing start')
    const continuation = { runtimeId: 'opencode' as const, endpointId, id: started.sessionId }
    const resumed = await collect(spec({ continuation, prompt: 'again' }))
    expect(resumed[0]).toMatchObject({ _tag: 'Started', sessionId: continuation.id })
    expect(resumed).toContainEqual({ _tag: 'Assistant', text: 'OpenCode: again' })
    expect(liveChildCount()).toBe(0)
  })
  it("recovers only a missing continuation and can fork an existing native session", async () => {
    const server = await OpenCodeServer.start(options)
    try {
      const directory = await realpath('/tmp')
      const missing = spec({ continuation: { runtimeId: 'opencode', endpointId, id: 'ses_missing' } })
      const created = await openOpenCodeSession(server, missing, directory)
      expect(created.fresh).toBe(true)
      const resumed = spec({ continuation: { runtimeId: 'opencode', endpointId, id: created.session.id } })
      expect((await openOpenCodeSession(server, resumed, directory)).session.id).toBe(created.session.id)
      const forked = await openOpenCodeSession(server, resumed, '/foreign')
      expect(forked.session).toMatchObject({ directory: '/foreign' })
      expect(forked.session.id).not.toBe(created.session.id)
    } finally { await server.close() }
  })
  it("correlates concurrent sessions sharing one authenticated server", async () => {
    const instance = runtime()
    const [one, two] = await Promise.all([collect(spec({ prompt: 'one' }), instance), collect(spec({ prompt: 'two', providerId: ProviderId.make('beta') }), instance)])
    expect(one.filter(e => e._tag === 'Assistant')).toEqual([{ _tag: 'Assistant', text: 'OpenCode: one' }])
    expect(two.filter(e => e._tag === 'Assistant')).toEqual([{ _tag: 'Assistant', text: 'OpenCode: two' }])
    expect(liveChildCount()).toBe(0)
  })
  it("routes permissions through the gate and never approves read-only writes", async () => {
    const events = await collect(spec({ prompt: 'permission', mode: 'read-only' }))
    expect(events).toContainEqual({ _tag: 'Assistant', text: 'OpenCode: permission reject' })
    const allowed = await Effect.runPromise(runtime().run(spec({ prompt: 'permission' }), { ...context, canUseTool: () => Effect.succeed('allow' as const) }).pipe(Stream.runCollect))
    expect(Array.from(allowed)).toContainEqual({ _tag: 'Assistant', text: 'OpenCode: permission once' })
  })
  it("routes structured questions through Jingler and supports Plan with Auto permissions", async () => {
    const asked: unknown[] = []
    const result = await Effect.runPromise(runtime().run(spec({ prompt: 'question', mode: 'plan' }), {
      ...context,
      askQuestion: (request) => {
        asked.push(request)
        return Effect.succeed([{ selected: ['One'], other: 'custom' }])
      }
    }).pipe(Stream.runCollect))
    expect(asked).toHaveLength(1)
    expect(Array.from(result)).toContainEqual({ _tag: 'Assistant', text: 'OpenCode: question One,custom' })
  })
  it("fails closed on disconnect and releases the server", async () => {
    await expect(collect(spec({ prompt: 'disconnect' }))).rejects.toThrow()
    expect(liveChildCount()).toBe(0)
  })
  it("interrupts the whole turn and rejects a foreign endpoint", async () => {
    const instance = runtime()
    await expect(Effect.runPromise(instance.run(spec({ prompt: 'wait' }), context).pipe(Stream.tap(event => event._tag === 'Started' ? instance.interrupt({ runtimeId: 'opencode', endpointId, id: event.sessionId }, 'desktop') : Effect.void), Stream.runDrain))).rejects.toThrow('interrupted')
    await expect(collect(spec({ endpointId: nativeCliEndpointId('foreign', 'opencode') }))).rejects.toThrow('Foreign')
    expect(liveChildCount()).toBe(0)
  })
  it("sanitizes inherited secrets and config injection", () => {
    expect(openCodeEnvironment({ HOME: '/home', OPENCODE_CONFIG_CONTENT: 'bad', OPENCODE_SERVER_PASSWORD: 'bad', ANTHROPIC_API_KEY: 'secret', NODE_OPTIONS: '--import evil' })).toEqual({ HOME: '/home' })
  })
  it("bounds JSON and individual SSE frames", async () => {
    await expect(boundedResponse(new Response('x'.repeat(8_388_609))).text()).rejects.toThrow('bound')
    await expect(boundedResponse(new Response('x'.repeat(1_048_577), { headers: { 'content-type': 'text/event-stream' } })).text()).rejects.toThrow('bound')
  })
  it("owns only a loopback child with fresh Basic auth and no inherited secrets", async () => {
    const credentials: string[] = []
    const spawnProcess: typeof spawn = ((command: string, args: string[], childOptions: Parameters<typeof spawn>[2]) => {
      expect(args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '54321'])
      expect(childOptions?.detached).toBe(true)
      const password = childOptions?.env?.OPENCODE_SERVER_PASSWORD
      expect(password?.length).toBeGreaterThanOrEqual(40)
      credentials.push(password!)
      return spawn(command, args, childOptions)
    }) as typeof spawn
    for (let index = 0; index < 2; index++) {
      const server = await OpenCodeServer.start({ ...options, spawnProcess })
      await server.close()
    }
    expect(credentials[0]).not.toBe(credentials[1])
    expect(liveChildCount()).toBe(0)
  })
  it("reaps a child on readiness timeout and spawn failure", async () => {
    await expect(OpenCodeServer.start({ ...options, timeoutMs: 80, fetch: async () => new Response(null, { status: 503 }) })).rejects.toThrow('readiness')
    const spawnProcess: typeof spawn = (() => spawn('/nonexistent/opencode')) as unknown as typeof spawn
    await expect(OpenCodeServer.start({ ...options, spawnProcess, timeoutMs: 80 })).rejects.toThrow()
    expect(liveChildCount()).toBe(0)
  })
  it("retains the owned server until its final lease is released", async () => {
    const acquire = makeOpenCodePool(options)
    const first = await acquire('desktop')
    const second = await acquire('desktop')
    expect(second.server).toBe(first.server)
    await first.release()
    expect(second.server.stopped.signal.aborted).toBe(false)
    await second.release()
    expect(liveChildCount()).toBe(0)
  })
})
