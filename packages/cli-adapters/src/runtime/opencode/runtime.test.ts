import { spawn } from "node:child_process"
import { fixtureTransport } from "./fixtures/transport.js"
import { fileURLToPath } from "node:url"
import { realpath, mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentEndpointCatalogEntry, CURRENT_RUNTIME_CONTRACTS, nativeCliEndpointId, ProviderId, ProviderModelId, type AgentRunSpec } from "@jingler/core"
import { Effect, Schema, Stream } from "effect"
import { describe, expect, it, vi } from "vitest"
import { liveChildCount } from "../../child-registry.js"
import { inactiveRuntimeActivity } from "../agent/agent-runtime.js"
import { probeOpenCodeEndpoint } from "./endpoint.js"
import { OpenCodeServer, boundedResponse, makeOpenCodePool, openCodeEnvironment } from "./server.js"
import { makeOpenCodeAgentRuntime, openOpenCodeSession, openCodePermissions, startOpenCodeTurnDeadline } from "./runtime.js"

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
    expect(entry.endpoint).toMatchObject({
      id: "device-1:opencode:default",
      status: "ready",
      features: { subagentFleet: true, backgroundTasks: true }
    })
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
    expect(first).toContainEqual({ _tag: "Usage", tokens: 15, window: 128000 })
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
  it("does not exempt competing jingler-prefixed servers in read-only mode", () => {
    const rules = openCodePermissions("read-only", new Set(["jingler_probe_echo"]))
    const decision = (tool: string) => rules.findLast(({ permission }) => permission === "*" || permission === tool)?.action
    expect(decision("jingler_probe_echo")).toBe("allow")
    expect(decision("jingler_extra_probe_echo")).toBe("deny")
    expect(rules.some(({ permission }) => permission === "jingler_*")).toBe(false)
  })
  it("rejects residual ambient MCP config before provider or MCP initialization", async () => {
    const requests: string[] = []
    const isolated = makeOpenCodeAgentRuntime({ ...options, fetch: async (input) => {
      const path = new URL((input as Request).url).pathname
      requests.push(path)
      return path === "/config" ? Response.json({ mcp: { jingler_extra: { type: "local", command: ["untrusted"] } } }) : transport.fetch(input)
    } })
    await expect(collect(spec({ mode: "read-only" }), isolated)).rejects.toThrow()
    expect(requests).not.toContain("/mcp")
    expect(requests).not.toContain("/provider")
    expect(liveChildCount()).toBe(0)
  })

  it.runIf(process.env.JINGLER_TEST_OPENCODE_LIVE === "1")("isolates hostile config on the pinned real server while retaining auth and continuations", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-opencode-isolation-"))
    const home = join(root, "home")
    const project = join(root, "project")
    const marker = join(root, "hostile-ran")
    const data = join(root, "data")
    const configHome = join(root, "config")
    const plugin = join(root, "hostile.mjs")
    const config = { provider: { "ambient-provider": { npm: "@ai-sdk/openai-compatible", name: "Ambient", options: { baseURL: "http://localhost:1" }, models: { "ambient-model": { name: "Ambient model" } } } }, plugin: [plugin], mcp: { jingler_extra: { type: "local", command: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'mcp')`] } } }
    const environment = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: data, XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state") }
    let server: OpenCodeServer | undefined
    try {
      for (const directory of [home, project, join(home, ".opencode"), join(configHome, "opencode"), join(data, "opencode")]) await mkdir(directory, { recursive: true })
      await writeFile(plugin, `import { writeFileSync } from 'node:fs'; export default async () => { writeFileSync(${JSON.stringify(marker)}, 'plugin'); return {} }`)
      for (const directory of [project, join(home, ".opencode"), join(configHome, "opencode")]) await writeFile(join(directory, "opencode.json"), JSON.stringify(config))
      await writeFile(join(data, "opencode", "auth.json"), JSON.stringify({ anthropic: { type: "api", key: "test-not-a-real-key" } }), { mode: 0o600 })
      server = await OpenCodeServer.start({ environment })
      const resolved = (await server.client.config.get({ directory: project }, { throwOnError: true })).data
      expect(Object.keys(resolved.mcp ?? {})).toEqual([])
      expect(resolved.plugin ?? []).toEqual([])
      const providers = (await server.client.provider.list({ directory: project }, { throwOnError: true })).data
      expect(providers.connected).toContain("anthropic")
      const discovered = await probeOpenCodeEndpoint({ environment })
      expect(discovered.models.some(({ providerId }) => providerId === "ambient-provider")).toBe(false)
      expect(discovered.models.some(({ providerId }) => providerId === "anthropic")).toBe(true)
      expect(await server.client.mcp.status({ directory: project }, { throwOnError: true }).then(({ data }) => Object.keys(data))).toEqual([])
      const session = (await server.client.session.create({ directory: project, permission: openCodePermissions("read-only") }, { throwOnError: true })).data
      await server.close()
      server = await OpenCodeServer.start({ environment })
      expect((await server.client.session.get({ directory: project, sessionID: session.id }, { throwOnError: true })).data.id).toBe(session.id)
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" })
    } finally { await server?.close(); await rm(root, { recursive: true, force: true }) }
  }, 60_000)

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
  it("reaps a session that finishes initializing after cancellation", async () => {
    let releaseResponse = () => {}
    let createdId = ""
    let resolveCreated = () => {}
    const created = new Promise<void>((resolve) => { resolveCreated = resolve })
    const delayed = makeOpenCodeAgentRuntime({ ...options, fetch: async input => {
      const request = input as Request
      const response = await transport.fetch(input)
      if (request.method === "POST" && new URL(request.url).pathname === "/session") {
        createdId = ((await response.clone().json()) as { id: string }).id
        resolveCreated()
        await new Promise<void>((resolve) => { releaseResponse = resolve })
      }
      return response
    } })
    const controller = new AbortController()
    const running = Effect.runPromise(delayed.run(spec(), context).pipe(Stream.runCollect), { signal: controller.signal })
    await created
    controller.abort()
    releaseResponse()
    await expect(running).rejects.toThrow()
    expect(transport.requests.some((request) => new URL(request.url).pathname === `/session/${createdId}/abort`)).toBe(true)
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

it.each(["data: {broken\n\n", "data: null\n\n", 'data: {"directory":"/tmp"}\n\n'])("rejects malformed SSE/envelopes and releases the server (%#)", async (frame) => {
  const instance = makeOpenCodeAgentRuntime({ ...options, fetch: async input => {
    if ((input as Request).url.includes("/global/event")) return new Response(frame, { headers: { "content-type": "text/event-stream" } })
    return transport.fetch(input)
  } })
  await expect(collect(spec(), instance)).rejects.toThrow()
  expect(liveChildCount()).toBe(0)
})

it("rejects malformed endpoint JSON and reaps the probe process", async () => {
  const entry = await probeOpenCodeEndpoint({ ...options, fetch: async input => {
    if ((input as Request).url.endsWith("/provider")) return new Response("{broken", { headers: { "content-type": "application/json" } })
    return transport.fetch(input)
  } })
  expect(entry.endpoint.status).toBe("error")
  expect(liveChildCount()).toBe(0)
})

it("keeps one completion when interrupt arrives at the terminal event", async () => {
  const instance = runtime()
  let id = ""
  const events = [...await Effect.runPromise(instance.run(spec(), context).pipe(
    Stream.tap(event => {
      if (event._tag === "Started") id = event.sessionId
      return event._tag === "Done"
        ? instance.interrupt({ runtimeId: "opencode", endpointId, id }, "desktop").pipe(Effect.ignore)
        : Effect.void
    }), Stream.runCollect
  ))]
  expect(events.filter(event => event._tag === "Done")).toHaveLength(1)
  expect(events.some(event => event._tag === "Failed")).toBe(false)
  expect(liveChildCount()).toBe(0)
})

it("pauses only operator review time in the OpenCode active-turn deadline", () => {
  vi.useFakeTimers()
  const expire = vi.fn()
  let pending = false
  const timer = startOpenCodeTurnDeadline(() => pending, expire)
  try {
    vi.advanceTimersByTime(29 * 60_000)
    expect(expire).not.toHaveBeenCalled()
    pending = true
    vi.advanceTimersByTime(2 * 60 * 60_000)
    expect(expire).not.toHaveBeenCalled()
    pending = false
    vi.advanceTimersByTime(60_000)
    expect(expire).toHaveBeenCalledOnce()
  } finally { clearInterval(timer); vi.useRealTimers() }
})
