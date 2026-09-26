import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import {
  SUBAGENT_CAPABILITY_VERSION,
  SubagentJsonValue,
  SubagentToolInputSchema,
  SubagentToolRequest,
  type AgentRole,
  type RuntimeMode,
  type SubagentCapability,
  type SubagentCapabilityTool,
  type SubagentSupervisorSnapshot,
  type SubagentToolResponse
} from "@jingler/core"
import {
  Context,
  Effect,
  Exit,
  FiberSet,
  JSONSchema,
  Layer,
  Ref,
  Schema,
  Scope,
  SynchronizedRef
} from "effect"
import type { AgentRuntimeContext } from "../agent/agent-runtime.js"
import { executeRegistryTool } from "../agent/registry-tool-bridge.js"
import type { ToolRegistry, ToolResultEnvelope, ToolRisk } from "../tools/tool-registry.js"

const MAX_BODY_BYTES = 1024 * 1024
const PARENT_ONLY_TOOLS = new Set([
  "jingler_ask_question",
  "plannotator_submit_plan",
  "plannotator_update_plan",
  "jingler_publish_explanation"
])
const READ_ONLY_AGENTS = new Set(["advisor", "oracle", "reviewer"])
const SAFE_AGENT_NAME = /^[a-z][a-z0-9-]*$/u
const SUPERVISOR_STATE_TOOL: SubagentCapabilityTool = {
  id: "supervisor_state",
  description: "Read the current parent and sibling supervision state for this run.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read"
}

export interface SubagentParentSpec {
  readonly role: AgentRole
  readonly mode: RuntimeMode
  readonly targetCapabilities: { readonly targetId: string }
}

interface RegisteredChild {
  readonly parentRuntimeSessionId: string
  readonly agent: string
  readonly role: AgentRole
  readonly mode: RuntimeMode
  readonly grantedToolIds: ReadonlySet<string>
  readonly registry: ToolRegistry
  readonly context: AgentRuntimeContext
  readonly supervisorState: () => SubagentSupervisorSnapshot
}

interface BrokerState {
  readonly endpoint: string
  readonly children: ReadonlyMap<string, RegisteredChild>
  readonly parentTokens: ReadonlyMap<string, ReadonlySet<string>>
}

export interface RegisterSubagentParentInput {
  readonly parentRuntimeSessionId: string
  readonly agents: ReadonlyArray<string>
  readonly spec: SubagentParentSpec
  readonly registry: ToolRegistry
  readonly context: AgentRuntimeContext
  readonly supervisorState: () => SubagentSupervisorSnapshot
}

export interface SubagentCapabilityBrokerShape {
  readonly register: (
    input: RegisterSubagentParentInput
  ) => Effect.Effect<ReadonlyArray<SubagentCapability>, Error>
  readonly unregister: (parentRuntimeSessionId: string) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

export type SubagentCapabilityBroker = SubagentCapabilityBrokerShape

export class SubagentCapabilityBrokerService extends Context.Tag(
  "@jingler/SubagentCapabilityBroker"
)<SubagentCapabilityBrokerService, SubagentCapabilityBrokerShape>() {}

const writeJson = <Value>(
  response: ServerResponse,
  status: number,
  value: Value
): Effect.Effect<void> => Effect.sync(() => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  })
  response.end(JSON.stringify(value))
})

const responseFrom = (result: ToolResultEnvelope): SubagentToolResponse => ({
  version: SUBAGENT_CAPABILITY_VERSION,
  status: result.status,
  value: result.value === null || result.value === undefined
    ? null
    : Schema.decodeUnknownSync(SubagentJsonValue)(JSON.parse(JSON.stringify(result.value))),
  preview: result.preview,
  error: result.error
})

export const childExecutionProfile = (
  spec: SubagentParentSpec,
  agent: string
): { readonly role: AgentRole; readonly mode: RuntimeMode } =>
  READ_ONLY_AGENTS.has(agent)
    ? { role: "review", mode: "read-only" }
    : { role: spec.role, mode: spec.mode }

export const subagentCapabilityTools = (
  registry: ToolRegistry,
  role: AgentRole,
  mode: RuntimeMode
): ReadonlyArray<SubagentCapabilityTool> => [
  ...registry.capabilitiesFor(role, mode)
    .filter((tool) => !PARENT_ONLY_TOOLS.has(tool.id) && tool.id !== SUPERVISOR_STATE_TOOL.id)
    .map((tool) => {
      const schema = registry.inputSchemaFor(tool.id)
      if (schema === null) throw new Error(`Active child tool has no input schema: ${tool.id}`)
      try {
        const providerSchema = registry.providerInputSchemaFor(tool.id) ?? JSONSchema.make(schema)
        return {
          id: tool.id,
          description: tool.description,
          inputSchema: Schema.decodeUnknownSync(SubagentToolInputSchema)(
            typeof providerSchema === "object" && providerSchema !== null && !Array.isArray(providerSchema)
              ? { ...providerSchema, type: "object" }
              : providerSchema
          ),
          risk: registry.riskFor(tool.id) ?? "read"
        }
      } catch (cause) {
        throw new Error(`Active child tool has an unsupported input schema: ${tool.id}`, { cause })
      }
    }),
  SUPERVISOR_STATE_TOOL
]

export const subagentCapabilityToolIds = (
  registry: ToolRegistry,
  spec: SubagentParentSpec,
  agent: string
): ReadonlyArray<string> => {
  const profile = childExecutionProfile(spec, agent)
  return subagentCapabilityTools(registry, profile.role, profile.mode).map(({ id }) => id)
}

const readBody = (request: IncomingMessage): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        length += bytes.byteLength
        if (length > MAX_BODY_BYTES) throw new Error("request-too-large")
        chunks.push(bytes)
      }
      return Buffer.concat(chunks).toString("utf8")
    },
    catch: (cause) => cause instanceof Error ? cause : new Error("Could not read request")
  })

const listen = (server: Server): Effect.Effect<string, Error> => Effect.async((resume) => {
  const onError = (cause: Error): void => resume(Effect.fail(cause))
  server.once("error", onError)
  server.listen(0, "127.0.0.1", () => {
    server.off("error", onError)
    const address = server.address()
    if (!address || typeof address === "string") {
      resume(Effect.fail(new Error("Subagent capability broker did not bind a TCP port")))
      return
    }
    resume(Effect.succeed(`http://127.0.0.1:${address.port}/v1/subagent-tool`))
  })
  return Effect.sync(() => server.close())
})

const closeServer = (server: Server): Effect.Effect<void> => Effect.async((resume) => {
  if (!server.listening) {
    resume(Effect.void)
    return
  }
  server.close(() => resume(Effect.void))
})

const handleRequest = (
  ref: Ref.Ref<BrokerState>,
  request: IncomingMessage,
  response: ServerResponse
): Effect.Effect<void> => Effect.gen(function* () {
  if (request.method !== "POST" || request.url !== "/v1/subagent-tool") {
    return yield* writeJson(response, 404, { error: "not-found" })
  }
    return yield* executeCapabilityRequest(request, ref, response)
}).pipe(
  Effect.catchAll((cause) => writeJson(
    response,
    cause instanceof SyntaxError ? 400 : 422,
    { error: cause instanceof Error ? cause.message : "invalid-request" }
  ))
)

export const makeSubagentCapabilityBroker = (): Effect.Effect<
  SubagentCapabilityBrokerShape,
  Error
> => Effect.gen(function* () {
  const requestScope = yield* Scope.make()
  const runRequest = yield* Scope.extend(FiberSet.makeRuntime<never, void, never>(), requestScope)
  const server = createServer()
  const endpoint = yield* listen(server).pipe(
    Effect.onError(() => closeServer(server).pipe(
      Effect.andThen(Scope.close(requestScope, Exit.void))
    ))
  )
  const ref = yield* SynchronizedRef.make<BrokerState>({
    endpoint,
    children: new Map(),
    parentTokens: new Map()
  })
  server.on("request", (request, response) => {
    runRequest(handleRequest(ref, request, response))
  })

  const unregister = (parentRuntimeSessionId: string): Effect.Effect<void> =>
    Ref.update(ref, (state) => {
      const children = new Map(state.children)
      for (const token of state.parentTokens.get(parentRuntimeSessionId) ?? []) children.delete(token)
      const parentTokens = new Map(state.parentTokens)
      parentTokens.delete(parentRuntimeSessionId)
      return { ...state, children, parentTokens }
    })

  return {
    register: (input) => Effect.gen(function* () {
      const agents = [...new Set(input.agents)]
      if (agents.length === 0 || agents.some((agent) => !SAFE_AGENT_NAME.test(agent))) {
        return yield* Effect.fail(new Error(
          "Subagent capability registration requires safe agent names"
        ))
      }
      return yield* SynchronizedRef.modifyEffect(ref, (state) => Effect.try({
        try: () => {
          const children = new Map(state.children)
          for (const token of state.parentTokens.get(input.parentRuntimeSessionId) ?? []) {
            children.delete(token)
          }
          const parentTokens = new Map(state.parentTokens)
          const tokens = new Set<string>()
          const capabilities = agents.map((agent) => {
            const token = randomBytes(32).toString("base64url")
            const profile = childExecutionProfile(input.spec, agent)
            const tools = subagentCapabilityTools(input.registry, profile.role, profile.mode)
            children.set(token, {
              parentRuntimeSessionId: input.parentRuntimeSessionId,
              agent,
              role: profile.role,
              mode: profile.mode,
              grantedToolIds: new Set(tools.map(({ id }) => id)),
              registry: input.registry,
              context: input.context,
              supervisorState: input.supervisorState
            })
            tokens.add(token)
            return {
              version: SUBAGENT_CAPABILITY_VERSION,
              endpoint: state.endpoint,
              token,
              parentRuntimeSessionId: input.parentRuntimeSessionId,
              agent,
              targetId: input.spec.targetCapabilities.targetId,
              role: profile.role,
              mode: profile.mode,
              tools
            } satisfies SubagentCapability
          })
          parentTokens.set(input.parentRuntimeSessionId, tokens)
          return [capabilities, { ...state, children, parentTokens }] as const
        },
        catch: (cause) => cause instanceof Error
          ? cause
          : new Error("Could not register subagent capabilities")
      }))
    }),
    unregister,
    close: Ref.set(ref, {
      endpoint,
      children: new Map(),
      parentTokens: new Map()
    }).pipe(
      Effect.andThen(closeServer(server)),
      Effect.andThen(Scope.close(requestScope, Exit.void))
    )
  }
})

export const SubagentCapabilityBrokerLive = Layer.scoped(
  SubagentCapabilityBrokerService,
  Effect.acquireRelease(makeSubagentCapabilityBroker(), (broker) => broker.close)
)

function* executeCapabilityRequest(
  request: IncomingMessage,
  ref: Ref.Ref<BrokerState>,
  response: ServerResponse<IncomingMessage>
) {
  const raw = yield* readBody(request)
  const decoded = yield* Schema.decodeUnknown(Schema.parseJson(SubagentToolRequest))(raw, {
    onExcessProperty: "error"
  })
  const state = yield* Ref.get(ref)
  const child = state.children.get(decoded.token)
  if (!child || child.parentRuntimeSessionId !== decoded.parentRuntimeSessionId) {
    return yield* writeJson(response, 403, { error: "forbidden" })
  }
  if (!child.grantedToolIds.has(decoded.toolId)) {
    return yield* writeJson(response, 403, { error: "forbidden-tool" })
  }
  if (decoded.toolId === SUPERVISOR_STATE_TOOL.id) {
    return yield* writeJson(response, 200, {
      version: SUBAGENT_CAPABILITY_VERSION,
      status: "success",
      value: Schema.decodeUnknownSync(SubagentJsonValue)(
        JSON.parse(JSON.stringify(child.supervisorState()))
      ),
      preview: null,
      error: null
    } satisfies SubagentToolResponse)
  }
  const risk: ToolRisk | null = child.registry.riskFor(decoded.toolId)
  if (risk === null) return yield* writeJson(response, 403, { error: "unknown-tool" })
  const result = yield* Effect.tryPromise(() => executeRegistryTool({
    registry: child.registry,
    spec: child,
    context: child.context,
    id: decoded.toolId,
    toolCallId: decoded.callId,
    parameters: decoded.arguments,
    signal: undefined,
    allowed: true,
    onUpdate: undefined
  }))
  yield* writeJson(response, 200, responseFrom(result.details))
}
