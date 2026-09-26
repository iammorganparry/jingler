import { fileURLToPath } from "node:url"
import { CURRENT_RUNTIME_CONTRACTS, nativeCliEndpointId, ProviderId, ProviderModelId, type AgentRunSpec, type StreamEvent } from "@jingler/core"
import { Effect, Schema, Stream } from "effect"
import { expect, it } from "vitest"
import { probeCodexEndpoint } from "../codex/endpoint.js"
import { probeOpenCodeEndpoint } from "../opencode/endpoint.js"
import { makeCodexAgentRuntime } from "../codex/runtime.js"
import { makeOpenCodeAgentRuntime } from "../opencode/runtime.js"
import { fixtureTransport } from "../opencode/fixtures/transport.js"
import { ToolRegistry } from "../tools/tool-registry.js"
import { inactiveRuntimeActivity } from "./agent-runtime.js"
import type { NativeRuntimeToolsOptions } from "./native-runtime-tools.js"

const createToolRegistry: NativeRuntimeToolsOptions["createToolRegistry"] = (spec) => {
  const registry = new ToolRegistry()
  registry.register({
    id: "probe_echo", version: "1", description: "Return this chat's fixture identity.", input: Schema.Struct({}),
    roles: ["conversation"], modes: ["auto"], risk: "read", timeoutMs: 1000, outputBudget: 1000,
    cancellable: true, idempotency: "safe", execute: async () => ({ owner: spec.chatId })
  })
  return Effect.succeed(registry)
}
const context = { ...inactiveRuntimeActivity, canUseTool: () => Effect.succeed("deny" as const), askQuestion: () => Effect.succeed([]) }

it.each(["codex", "opencode"] as const)("%s consumes shared registry results and core rules with isolated concurrent chats and refreshed resume", async (runtimeId) => {
  const transport = fixtureTransport()
  const runtime = runtimeId === "codex"
    ? makeCodexAgentRuntime({ binary: fileURLToPath(new URL("../codex/fixtures/app-server.mjs", import.meta.url)), environment: { ...process.env, CODEX_HOME: "unique-threads" }, createToolRegistry })
    : makeOpenCodeAgentRuntime({ ...transport.options(fileURLToPath(new URL("../opencode/fixtures/server.mjs", import.meta.url))), createToolRegistry })
  const input = (chatId: string): AgentRunSpec => ({
    runId: chatId, sessionId: "session", chatId, runtimeId, endpointId: nativeCliEndpointId("desktop", runtimeId),
    providerId: ProviderId.make(runtimeId === "codex" ? "openai" : "alpha"),
    modelId: ProviderModelId.make(runtimeId === "codex" ? "first" : "fixture-model"),
    cwd: "/tmp", role: "conversation", mode: "auto", prompt: "registry-probe", priorMessages: [], continuation: null, seed: null,
    targetCapabilities: { versions: CURRENT_RUNTIME_CONTRACTS, targetId: "desktop", toolIds: [], resourceIds: [] }
  })
  const run = async (spec: AgentRunSpec) => {
    const published: StreamEvent[] = []
    const stream = [...await Effect.runPromise(runtime.run(spec, {
      ...context, publishEvent: (event) => Effect.sync(() => { published.push(event) })
    }).pipe(Stream.runCollect))]
    const text = stream.flatMap((event) => event._tag === "Assistant" ? [event.text] : []).join("")
    expect(text).toContain('"inherited":true')
    expect(text).toContain(spec.chatId)
    expect(published.filter((event) => event._tag === "ToolStart")).toHaveLength(1)
    expect(published.filter((event) => event._tag === "ToolEnd")).toHaveLength(1)
    expect(stream.filter((event) => event._tag === "ToolStart" || event._tag === "ToolEnd")).toHaveLength(0)
    return stream.find((event) => event._tag === "Started")!
  }
  const [first] = await Promise.all([run(input("chat-A")), run(input("chat-B"))])
  await run({ ...input("chat-A"), continuation: { runtimeId, endpointId: input("chat-A").endpointId, id: first.sessionId } })
  if (runtimeId === "opencode") {
    const requests = transport.requests.filter((request) => new URL(request.url).pathname === "/mcp")
    const attachments = await Promise.all(requests.map((request) => request.json() as Promise<{ config: { url: string; headers: Record<string, string> } }>))
    expect(new Set(attachments.map(({ config }) => config.headers.Authorization)).size).toBe(3)
    await Promise.all(attachments.map(({ config }) => expect(fetch(config.url)).rejects.toThrow()))
    expect(new Set(requests.map((request) => request.headers.get("authorization"))).size).toBe(3)
  }
})

it.runIf(process.env.JINGLER_NATIVE_CAPABILITIES_LIVE === "1").each(["codex", "opencode"] as const)("live %s reads a Jingler-owned tool result", async (runtimeId) => {
  const entry = await (runtimeId === "codex" ? probeCodexEndpoint() : probeOpenCodeEndpoint())
  expect(entry.endpoint.status).toBe("ready")
  const model = entry.models.find((model) => model.selectable && model.id === "big-pickle") ?? entry.models.find((model) => model.selectable && (model.id.includes("mini") || model.id.includes("haiku"))) ?? entry.models.find((model) => model.selectable)
  if (!model) throw new Error("No selectable native model")
  console.info("Live model:", runtimeId, model.providerId, model.id)
  const runtime = runtimeId === "codex" ? makeCodexAgentRuntime({ createToolRegistry }) : makeOpenCodeAgentRuntime({ createToolRegistry })
  const events: StreamEvent[] = []
  const spec: AgentRunSpec = {
    runId: "live-probe", sessionId: "live-probe", chatId: "JINGLER_LIVE_RESULT_73", runtimeId,
    endpointId: entry.endpoint.id, providerId: model.providerId, modelId: model.id,
    cwd: "/tmp", role: "conversation", mode: "auto", prompt: "Call probe_echo exactly once. Reply only with the JSON it returns. Do not use any other tools.",
    priorMessages: [], continuation: null, seed: null,
    targetCapabilities: { versions: CURRENT_RUNTIME_CONTRACTS, targetId: "desktop", toolIds: [], resourceIds: [] }
  }
  const stream = [...await Effect.runPromise(runtime.run(spec, {
    ...context, publishEvent: (event) => Effect.sync(() => { events.push(event) })
  }).pipe(Stream.runCollect, Effect.timeout("120 seconds")))]
  const answer = stream.flatMap((event) => event._tag === "Assistant" ? [event.text] : []).join("")
  expect(events.filter((event) => event._tag === "ToolEnd" && event.status === "success"), answer).toHaveLength(1)
  expect(stream.flatMap((event) => event._tag === "Assistant" ? [event.text] : []).join(""))
    .toContain("JINGLER_LIVE_RESULT_73")
}, 150_000)
