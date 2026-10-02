import { makeCodexEndpointLogin } from "./login.js"
import { liveChildCount } from "../../child-registry.js"
import { delimiter } from "node:path"
import { fileURLToPath } from "node:url"
import {
  AgentEndpointCatalogEntry,
  CURRENT_RUNTIME_CONTRACTS,
  nativeCliEndpointId,
  ProviderModelId,
  type AgentRunSpec,
  type StreamEvent
} from "@jingler/core"
import { Effect, Fiber, Schema, Stream } from "effect"
import { describe, expect, it, vi } from "vitest"
import { inactiveRuntimeActivity } from "../agent/agent-runtime.js"
import { CodexClient, codexEnvironment, readCodexVersion } from "./client.js"
import { probeCodexEndpoint, startCodexEndpointLogin } from "./endpoint.js"
import { CodexEvents } from "./events.js"
import { codexMcpConfig, makeCodexAgentRuntime } from "./runtime.js"

const binary = fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url))
const endpointId = nativeCliEndpointId("desktop", "codex")
const spec = (over: Partial<AgentRunSpec> = {}): AgentRunSpec => ({
  runId: "run",
  sessionId: "session",
  chatId: "chat",
  runtimeId: "codex",
  endpointId,
  modelId: ProviderModelId.make("first"),
  role: "conversation",
  mode: "auto",
  cwd: "/tmp",
  prompt: "hello",
  priorMessages: [],
  continuation: null,
  seed: null,
  targetCapabilities: {
    versions: CURRENT_RUNTIME_CONTRACTS,
    toolIds: [],
    resourceIds: [],
    targetId: "desktop"
  },
  ...over
})
const context = {
  ...inactiveRuntimeActivity,
  canUseTool: () => Effect.succeed("deny" as const),
  askQuestion: () => Effect.succeed([{ selected: ["One"], other: null }])
}
const collect = (input = spec()) =>
  Effect.runPromise(
    makeCodexAgentRuntime({ binary }).run(input, context).pipe(Stream.runCollect)
  ).then((events) => Array.from(events))

const approvalResponse = (allowed: boolean, prompt: string) => prompt === "permissions"
  ? { scope: "turn", permissions: allowed ? { fileSystem: { write: ["/tmp"] } } : {} }
  : { decision: allowed ? "accept" : "decline" }

describe("native Codex protocol", () => {
  it("negotiates, correlates and bounds the stdio protocol", async () => {
    const client = new CodexClient({ binary, timeoutMs: 500 })
    try {
      await client.initialize()
      expect(await client.request("account/read", {})).toHaveProperty("account")
    } finally {
      await client.close()
    }
  })
  it.each(["malformed", "oversized", "timeout", "exit"])("cleans up on %s", async (method) => {
    const client = new CodexClient({ binary, timeoutMs: 100, maxFrameBytes: 1000 })
    await client.initialize()
    await expect(client.request(method, {})).rejects.toThrow()
    await client.close()
  })
  it("discovers native models with bounded pagination and target identity", async () => {
    const entry = await probeCodexEndpoint({ binary, targetId: "device-1" })
    expect(entry.endpoint).toMatchObject({
      status: "ready",
      targetId: "device-1",
      label: "Codex CLI",
      features: { subagentFleet: true, backgroundTasks: true }
    })
    expect(entry.models.map((model) => model.id)).toEqual(["first", "second"])
    expect(entry.models[0]!.capabilities.contextWindow).toBeNull()
  })
  it("distinguishes signed-out and missing binaries", async () => {
    expect(
      (await probeCodexEndpoint({ binary, environment: { ...process.env, CODEX_HOME: "signed-out" } }))
        .endpoint.status
    ).toBe("signed-out")
    expect((await probeCodexEndpoint({ binary: "/nonexistent/codex" })).endpoint.status).toBe(
      "missing"
    )
  })
  it("inherits models from newer compatible CLI versions", async () => {
    const entry = await probeCodexEndpoint({
      binary,
      environment: { ...process.env, CODEX_HOME: "0.154.0" }
    })
    expect(entry.endpoint).toMatchObject({ status: "ready", version: "0.154.0" })
    expect(entry.models.map((model) => model.id)).toEqual(["first", "second"])
  })
  it("starts and cancels native login without PI OAuth", async () => {
    const login = await startCodexEndpointLogin({ binary })
    expect(login.userCode).toBe("TEST")
    await login.cancel()
  })
  it("owns and bounds native login by endpoint, target, and login ID", async () => {
    const service = makeCodexEndpointLogin({ binary })
    await expect(service.start(endpointId, "other-target")).rejects.toThrow("own")
    const login = await service.start(endpointId, "desktop")
    try {
      await expect(service.start(endpointId, "desktop")).rejects.toThrow("pending")
      await expect(service.cancel(endpointId, "desktop", "wrong")).rejects.toThrow("belong")
    } finally { await service.cancel(endpointId, "desktop", login.loginId) }
    const restarted = await service.start(endpointId, "desktop")
    await service.cancel(endpointId, "desktop", restarted.loginId)
  })
  it("normalizes text/thinking and resident context, ignoring foreign threads", async () => {
    const events = await collect()
    expect(events).toContainEqual({ _tag: "Assistant", text: "Codex: hello" })
    // Selectively reused the resident-context fixture from 430da133^.
    expect(events).toContainEqual({ _tag: "Usage", tokens: 193496, window: 258400 })
    expect(JSON.stringify(events)).not.toContain("WRONG")
    expect(events.at(-1)?._tag).toBe("Done")
  })
  it("resumes persisted IDs and recovers missing threads", async () => {
    for (const id of ["persisted", "missing"]) {
      const events = await collect(spec({ continuation: { runtimeId: "codex", endpointId, id } }))
      expect(events[0]).toMatchObject({
        _tag: "Started",
        sessionId: id === "missing" ? "thread-1" : id
      })
    }
  })
  it("routes approval and structured answers through the run context", async () => {
    expect(await collect(spec({ prompt: "approval" }))).toContainEqual({
      _tag: "Assistant",
      text: '{"decision":"decline"}'
    })
    expect(await collect(spec({ prompt: "question" }))).toContainEqual({
      _tag: "Assistant",
      text: '{"answers":{"q1":{"answers":["One"]}}}'
    })
  })
  it("isolates simultaneous processes even when their thread IDs collide", async () => {
    const [a, b] = await Promise.all([
      collect(spec({ prompt: "one" })),
      collect(spec({ prompt: "two" }))
    ])
    expect(JSON.stringify(a)).not.toContain("Codex: two")
    expect(JSON.stringify(b)).not.toContain("Codex: one")
  })
  it("steers and interrupts the active turn", async () => {
    const runtime = makeCodexAgentRuntime({ binary })
    const continuation = { runtimeId: "codex" as const, endpointId, id: "thread-1" }
    const events: StreamEvent[] = []
    const running = Effect.runPromise(
      runtime.run(spec({ prompt: "wait" }), context).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event)
          })
        )
      )
    ).catch((error) => error)
    await expect
      .poll(() => events.some((event) => event._tag === "Assistant" && event.text === "ready"))
      .toBe(true)
    await Effect.runPromise(runtime.steer(continuation, "desktop", "steered"))
    await Effect.runPromise(runtime.interrupt(continuation, "desktop"))
    expect(String(await running)).toContain("interrupted")
    expect(events).toContainEqual({ _tag: "Assistant", text: "steered" })
  })
  it("reaps the owned process when the stream consumer cancels while idle", async () => {
    const before = liveChildCount()
    let ready = false
    const fiber = Effect.runFork(
      makeCodexAgentRuntime({ binary })
        .run(spec({ prompt: "wait" }), context)
        .pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event._tag === "Assistant") ready = true
            })
          )
        )
    )
    await expect.poll(() => ready).toBe(true)
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.timeout("2 seconds")))
    expect(liveChildCount()).toBe(before)
  })
  it("denies legacy approvals in read-only even if the host allows", async () => {
    const mode = "read-only"
    for (const prompt of ["approval", "file-approval"]) {
      const result = await Effect.runPromise(makeCodexAgentRuntime({ binary }).run(spec({ mode, prompt }), {
        ...context, canUseTool: () => Effect.succeed("allow" as const)
      }).pipe(Stream.runCollect))
      expect(Array.from(result)).toContainEqual({ _tag: "Assistant", text: '{"decision":"decline"}' })
    }
  })
  it("inherits the shared native environment plus only Codex home and CA paths", () => {
    expect(codexEnvironment({
      PATH: "/bin", HOME: "/home/test", APPDATA: "/app", LOCALAPPDATA: "/local",
      SystemRoot: "/system", CODEX_HOME: "/codex", CODEX_CA_CERTIFICATE: "/ca.pem",
      SSL_CERT_FILE: "/ssl.pem", OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "x",
      AZURE_OPENAI_API_KEY: "x", AWS_SECRET_ACCESS_KEY: "x", JINGLER_AUTH_TOKEN: "x",
      JINGLER_DEVICE_GRANT: "x", GH_TOKEN: "x", NODE_OPTIONS: "x", MCP_KEY: "x",
      CODEX_API_KEY: "x", USERPROFILE: "/not-in-shared-allowlist"
    }, "linux")).toEqual({
      PATH: "/bin", HOME: "/home/test", APPDATA: "/app", LOCALAPPDATA: "/local",
      SystemRoot: "/system", CODEX_HOME: "/codex", CODEX_CA_CERTIFICATE: "/ca.pem",
      SSL_CERT_FILE: "/ssl.pem"
    })
    expect(codexEnvironment({ CODEX_HOME: undefined }, "linux")).toEqual({})
    expect(codexEnvironment({ PATH: "/usr/bin" }, "darwin").PATH?.split(delimiter))
      .toEqual(["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"])
    expect(codexEnvironment({ HOME: "/Users/test" }, "darwin").PATH?.split(delimiter))
      .toEqual([
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/opt/homebrew/bin",
        "/usr/local/bin"
      ])
  })
  it.each(["ask", "accept-edits"] as const)("rejects %s before spawning rather than bypassing required approvals", async (mode) => {
    const spawnProcess = vi.fn()
    await expect(Effect.runPromise(
      makeCodexAgentRuntime({ binary, spawnProcess }).run(spec({ mode }), context)
        .pipe(Stream.runCollect)
    )).rejects.toThrow(`${mode} mode is unsupported`)
    expect(spawnProcess).not.toHaveBeenCalled()
  })
  it("fails closed on Windows before version probe, login or runtime spawn", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    const spawnProcess = vi.fn()
    const options = { binary: "/nonexistent/codex", spawnProcess }
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      await expect(readCodexVersion(options)).rejects.toThrow("unsupported on Windows")
      expect(() => new CodexClient(options)).toThrow("unsupported on Windows")
      await expect(startCodexEndpointLogin(options)).rejects.toThrow("unsupported on Windows")
      const entry = await probeCodexEndpoint(options)
      expect(entry.endpoint).toMatchObject({ status: "unsupported", version: null })
      expect(entry.models).toEqual([])
      await expect(Effect.runPromise(
        makeCodexAgentRuntime(options).run(spec(), context).pipe(Stream.runCollect)
      )).rejects.toThrow("unsupported on Windows")
      expect(spawnProcess).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })
  it.each(["auto", "plan", "read-only"] as const)("sets policy for fresh and resumed %s threads", async (mode) => {
    for (const id of [null, "persisted", "missing"]) {
      const events = await collect(spec({ mode, prompt: "policy", continuation: id ? { runtimeId: "codex", endpointId, id } : null }))
      expect(events).toContainEqual({ _tag: "Assistant", text: JSON.stringify({
        approvalPolicy: mode === "read-only" ? "never" : "on-request",
        sandbox: mode === "read-only" ? "read-only" : "workspace-write",
        approvalsReviewer: "user"
      }) })
    }
  })
  describe.each(["auto", "plan", "read-only"] as const)("%s approvals", (mode) => {
    it.each(["approval", "file-approval", "permissions"])("routes %s correctly", async (prompt) => {
      const canUseTool = vi.fn(() => Effect.succeed("allow" as const))
      const result = await Effect.runPromise(makeCodexAgentRuntime({ binary }).run(spec({ mode, prompt }), {
        ...context, canUseTool
      }).pipe(Stream.runCollect))
      const allowed = mode !== "read-only"
      const response = approvalResponse(allowed, prompt)
      expect(Array.from(result)).toContainEqual({ _tag: "Assistant", text: JSON.stringify(response) })
      expect(canUseTool).toHaveBeenCalledTimes(allowed ? 1 : 0)
      if (allowed) expect(canUseTool).toHaveBeenCalledWith({ toolId: "tool-1", risk: prompt === "approval" ? "execute" : "mutate" })
    })
  })
  it("deduplicates tool start/completion and late deltas, and bounds item state", () => {
    const events = new CodexEvents()
    const item = { id: "tool", type: "commandExecution", command: "pwd", status: "completed", exitCode: 0 }
    expect(events.map({ method: "item/started", params: { item } })).toHaveLength(1)
    expect(events.map({ method: "item/started", params: { item } })).toEqual([])
    expect(events.map({ method: "item/completed", params: { item } })).toHaveLength(1)
    expect(events.map({ method: "item/completed", params: { item } })).toEqual([])
    expect(events.map({ method: "item/commandExecution/outputDelta", params: { itemId: "tool", delta: "late" } })).toEqual([])
    for (let index = 0; index < 4095; index++) events.map({ method: "item/agentMessage/delta", params: { itemId: String(index), delta: "x" } })
    expect(() => events.map({ method: "item/agentMessage/delta", params: { itemId: "overflow", delta: "x" } })).toThrow("bound")
  })
  it("caps and deduplicates model pages to the public catalog contract", async () => {
    const entry = await probeCodexEndpoint({ binary, environment: { ...process.env, CODEX_HOME: "many-models" } })
    expect(() => Schema.decodeUnknownSync(AgentEndpointCatalogEntry)(entry)).not.toThrow()
    expect(entry.models).toHaveLength(256)
    expect(new Set(entry.models.map((model) => model.id)).size).toBe(256)
  })
  it("keeps MCP credentials out of protocol configuration", () => {
    const attachment = codexMcpConfig(
      {
        ...context,
        mcp: {
          browser: {
            name: "browser",
            url: "http://127.0.0.1:1234/mcp",
            headers: { Authorization: "secret" }
          }
        }
      },
      {}
    )
    expect(JSON.stringify(attachment.config)).not.toContain("secret")
    expect(Object.values(attachment.env)).toContain("secret")
  })
  it("maps command snapshots and file diffs", () => {
    const events = new CodexEvents()
    const message = (method: string, params: Record<string, unknown>) =>
      events.map({ method, params })
    message("item/commandExecution/outputDelta", { itemId: "c1", delta: "RUN\n" })
    expect(message("item/commandExecution/outputDelta", { itemId: "c1", delta: "PASS\n" })).toEqual(
      [{ _tag: "ToolDelta", id: "c1", output: "RUN\nPASS\n" }]
    )
    expect(
      message("item/completed", {
        item: {
          type: "fileChange",
          id: "f1",
          status: "completed",
          changes: [{ path: "a.ts", diff: "+new\n-old" }]
        }
      })[0]
    ).toMatchObject({ _tag: "ToolEnd", diff: { added: 1, removed: 1 } })
  })
})

it("keeps one completion when interrupt arrives at the terminal event", async () => {
  const instance = makeCodexAgentRuntime({ binary })
  let id = ""
  const events = [...await Effect.runPromise(instance.run(spec(), context).pipe(
    Stream.tap(event => {
      if (event._tag === "Started") id = event.sessionId
      return event._tag === "Done"
        ? instance.interrupt({ runtimeId: "codex", endpointId, id }, "desktop").pipe(Effect.ignore)
        : Effect.void
    }), Stream.runCollect
  ))]
  expect(events.filter(event => event._tag === "Done")).toHaveLength(1)
  expect(events.some(event => event._tag === "Failed")).toBe(false)
  expect(liveChildCount()).toBe(0)
})
