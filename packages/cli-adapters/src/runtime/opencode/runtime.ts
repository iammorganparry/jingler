import { randomBytes } from "node:crypto"
import { realpath } from "node:fs/promises"
import { nativeCliEndpointId, type AgentRunSpec, type StreamEvent } from "@jingler/core"
import type { PermissionRuleset, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { Effect, Stream } from "effect"
import { AgentRuntimeError, type AgentRuntimeContext, type AgentRuntimeRegistration, type AgentRuntimeShape } from "../agent/agent-runtime.js"
import { acquireOpenCode, makeOpenCodePool, type OpenCodeOptions, type OpenCodeServer } from "./server.js"
import { OpenCodeEvents } from "./events.js"
import { OpenCodeInbox } from "./inbox.js"
import { readOpenCodeModels } from "./endpoint.js"

const failure = (cause: unknown) => cause instanceof AgentRuntimeError ? cause : new AgentRuntimeError({ reason: "runtime", message: "OpenCode turn failed; check the CLI configuration on this execution target" })
const unsupported = () => Effect.fail(new AgentRuntimeError({ reason: "runtime", message: "This operation is unavailable in native OpenCode" }))
const ownerKey = (endpoint: string, session: string) => JSON.stringify([endpoint, session])
const reads = ["read", "glob", "grep", "list", "lsp"]
export const openCodePermissions = (mode: AgentRunSpec["mode"]): PermissionRuleset => [
  { permission: "*", pattern: "*", action: mode === "read-only" ? "deny" : "ask" },
  ...reads.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
  // Task permissions cannot represent Jingler subagents; questions use Jingler's UI protocol.
  { permission: "task", pattern: "*", action: "deny" },
  { permission: "question", pattern: "*", action: "allow" }
]

/** Missing sessions alone recover by seeding. Auth, corruption and path mismatches fail. */
export const openOpenCodeSession = async (server: OpenCodeServer, spec: AgentRunSpec, directory: string) => {
  const permission = openCodePermissions(spec.mode)
  if (spec.continuation) {
    const existing = await server.client.session.get({ sessionID: spec.continuation.id, directory })
    if (existing.data) {
      let session = existing.data
      if (session.directory !== directory) {
        // A continuation moved to another verified workspace becomes an explicit
        // OpenCode fork instead of reusing history under the wrong filesystem.
        session = (await server.client.session.fork({ sessionID: session.id, directory }, { throwOnError: true })).data
      } else {
        const status = await server.client.session.status({ directory }, { throwOnError: true })
        if (status.data[session.id]?.type !== undefined && status.data[session.id]?.type !== "idle") throw new Error("OpenCode session is already active")
      }
      await server.client.session.update({ sessionID: session.id, directory, permission }, { throwOnError: true })
      return { session, fresh: false }
    }
    if (existing.response.status !== 404) throw new Error("OpenCode continuation lookup failed")
  }
  return { session: (await server.client.session.create({ directory, permission }, { throwOnError: true })).data, fresh: true }
}
const seedPrompt = (spec: AgentRunSpec) => [...(spec.seed?.messages ?? spec.priorMessages).map((message) => JSON.stringify({ role: message.role, text: message.parts.flatMap((part) => part._tag === "Text" ? [part.text] : []).join("\n") })), spec.prompt].join("\n")
const replyPermission = async (request: PermissionRequest, spec: AgentRunSpec, context: AgentRuntimeContext, server: OpenCodeServer, directory: string, signal: AbortSignal) => {
  const risk = request.permission === "edit" ? "mutate" : ["webfetch", "websearch"].includes(request.permission) ? "network" : "execute"
  const decision = spec.mode === "read-only" ? "deny" : await Effect.runPromise(context.canUseTool({ toolId: request.tool?.callID ?? request.id, risk }), { signal })
  if (!signal.aborted) await server.client.permission.reply({ directory, requestID: request.id, reply: decision === "allow" ? "once" : "reject" }, { throwOnError: true })
}
const replyQuestion = async (request: QuestionRequest, spec: AgentRunSpec, context: AgentRuntimeContext, server: OpenCodeServer, directory: string, signal: AbortSignal) => {
  const answers = await Effect.runPromise(context.askQuestion({
    id: `${spec.runId}:${request.id}`,
    questions: request.questions.map((question) => ({
      header: question.header,
      question: question.question,
      options: question.options,
      multiSelect: question.multiple ?? false
    }))
  }), { signal })
  if (signal.aborted) return
  await server.client.question.reply({
    requestID: request.id,
    directory,
    answers: request.questions.map((_, index) => [
      ...(answers[index]?.selected ?? []),
      ...(answers[index]?.other ? [answers[index].other] : [])
    ])
  }, { throwOnError: true })
}
const assertOwner = (spec: AgentRunSpec) => {
  if (spec.runtimeId !== "opencode" || spec.endpointId !== nativeCliEndpointId(spec.targetCapabilities.targetId, "opencode") || (spec.continuation && (spec.continuation.runtimeId !== spec.runtimeId || spec.continuation.endpointId !== spec.endpointId))) throw new Error("Foreign OpenCode owner")
  if (!spec.providerId) throw new Error("OpenCode requires an explicit provider identity")
}
interface Active { server: OpenCodeServer; directory: string; inbox: OpenCodeInbox }
export const makeOpenCodeAgentRuntime = (options?: OpenCodeOptions): AgentRuntimeShape => {
  const acquire = options ? makeOpenCodePool(options) : acquireOpenCode
  const active = new Map<string, Active>()
  const reservations = new Set<string>()
  return {
    run: (spec, context) => Stream.unwrapScoped(Effect.gen(function* () {
      yield* Effect.try({ try: () => {
        assertOwner(spec)
        if (context.mcp?.browser || context.mcp?.configured?.length) throw new Error("OpenCode run-scoped MCP attachments are unsupported")
        if (spec.reasoning) throw new Error("OpenCode reasoning overrides are unsupported")
      }, catch: (cause) => new AgentRuntimeError({ reason: "runtime", message: cause instanceof Error ? cause.message : "Invalid OpenCode run" }) })
      const lease = yield* Effect.acquireRelease(Effect.tryPromise({ try: () => acquire(spec.targetCapabilities.targetId), catch: failure }), (owned) => Effect.promise(owned.release))
      const abort = new AbortController()
      let cleanup = async () => { abort.abort() }
      yield* Effect.addFinalizer(() => Effect.promise(() => cleanup()))
      const iterator = run(spec, context, lease.server, abort, (fn) => { cleanup = fn })
      return Stream.fromAsyncIterable({ [Symbol.asyncIterator]: () => ({ next: () => iterator.next(), return: async () => { await cleanup(); return iterator.return(undefined) } }) }, failure)
    })),
    interrupt: (continuation, targetId) => Effect.tryPromise({ try: async () => {
      if (continuation.runtimeId !== "opencode" || continuation.endpointId !== nativeCliEndpointId(targetId, "opencode")) throw new Error("Foreign OpenCode interrupt")
      const run = active.get(ownerKey(continuation.endpointId, continuation.id))
      if (!run) throw new Error("OpenCode turn is not active")
      await run.server.client.session.abort({ sessionID: continuation.id, directory: run.directory }, { throwOnError: true })
      run.inbox.fail(new AgentRuntimeError({ reason: "interrupted", message: "OpenCode turn interrupted" }))
    }, catch: failure }),
    steer: unsupported, controlSubagent: unsupported, decidePlanReview: unsupported, subagentFleetSnapshot: unsupported, subagentTranscript: unsupported
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one scoped turn owns the reservation, event stream, and abort cleanup.
  async function* run(spec: AgentRunSpec, context: AgentRuntimeContext, server: OpenCodeServer, abort: AbortController, setCleanup: (fn: () => Promise<void>) => void): AsyncGenerator<StreamEvent> {
    const pendingKey = spec.continuation ? ownerKey(spec.endpointId, spec.continuation.id) : undefined
    if (pendingKey && reservations.has(pendingKey)) throw new Error("OpenCode session already reserved")
    if (pendingKey) reservations.add(pendingKey)
    let id: string | undefined
    let inbox: OpenCodeInbox | undefined
    let completed = false
    let cleaned = false
    let directory = spec.cwd
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: idempotent cleanup handles partially initialized turns.
    const cleanup = async () => {
      if (cleaned) return
      cleaned = true
      abort.abort()
      inbox?.close()
      if (id) {
        active.delete(ownerKey(spec.endpointId, id))
        if (!completed) {
          try { await server.client.session.abort({ sessionID: id, directory }, { throwOnError: true, signal: AbortSignal.timeout(2000) }) }
          catch { await server.close() }
        }
      }
      if (pendingKey) reservations.delete(pendingKey)
    }
    setCleanup(cleanup)
    const timeout = setTimeout(() => { inbox?.fail(new Error("OpenCode turn timed out")); abort.abort() }, 30 * 60_000)
    try {
      directory = await realpath(spec.cwd)
      const models = await readOpenCodeModels(server, directory)
      if (!models.some((model) => model.providerId === spec.providerId && model.id === spec.modelId && model.selectable)) throw new Error("OpenCode model is unavailable")
      const { session, fresh } = await openOpenCodeSession(server, spec, directory)
      id = session.id
      const key = ownerKey(spec.endpointId, id)
      if (active.has(key)) throw new Error("OpenCode session already active")
      inbox = new OpenCodeInbox(server, directory, id)
      active.set(key, { server, directory, inbox })
      await inbox.connectedBeforePrompt()
      const messageID = `msg_${Date.now().toString(16)}${randomBytes(12).toString("hex")}`
      const events = new OpenCodeEvents(id, messageID)
      const permissions = new Set<string>()
      const questions = new Set<string>()
      await server.client.session.promptAsync({ sessionID: id, directory, messageID, model: { providerID: spec.providerId!, modelID: spec.modelId }, agent: "build", parts: [{ type: "text", text: fresh ? seedPrompt(spec) : spec.prompt }, ...(spec.images ?? []).map((image) => ({ type: "file" as const, mime: image.mediaType, url: `data:${image.mediaType};base64,${image.data}` }))] }, { throwOnError: true })
      yield { _tag: "Started", sessionId: id, model: spec.modelId }
      for (;;) {
        const event = await inbox.next()
        if (event.type === "session.error") throw new Error("OpenCode session failed")
        if (event.type === "permission.asked") {
          const request = event.properties
          if (permissions.size >= 256 || permissions.has(request.id)) throw new Error("OpenCode permission bound exceeded")
          permissions.add(request.id)
          void replyPermission(request, spec, context, server, directory, abort.signal).catch(() => inbox?.fail(new Error("OpenCode permission reply failed")))
        }
        if (event.type === "question.asked") {
          const request = event.properties
          if (questions.size >= 32 || questions.has(request.id)) throw new Error("OpenCode question bound exceeded")
          questions.add(request.id)
          void replyQuestion(request, spec, context, server, directory, abort.signal)
            .catch(() => inbox?.fail(new Error("OpenCode question reply failed")))
            .finally(() => questions.delete(request.id))
        }
        if (event.type === "session.idle" || (event.type === "session.status" && event.properties.status.type === "idle")) {
          if (!events.hasResponse) continue
          completed = true
          yield { _tag: "Done", tokens: events.tokens, costUsd: events.cost }
          return
        }
        yield* events.map(event)
      }
    } finally { clearTimeout(timeout); await cleanup() }
  }
}
export const makeOpenCodeRuntimeRegistration = (options?: OpenCodeOptions): AgentRuntimeRegistration => ({ runtimeId: "opencode", runtime: makeOpenCodeAgentRuntime(options), ownsEndpoint: (endpointId, targetId) => endpointId === nativeCliEndpointId(targetId, "opencode") })
