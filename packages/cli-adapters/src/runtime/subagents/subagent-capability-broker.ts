import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import {
  SUBAGENT_CAPABILITY_VERSION,
  SubagentJsonValue,
  SubagentToolInputSchema,
  SubagentToolRequest,
  type AgentRole,
  type RuntimeMode,
  type SubagentCapability,
  type SubagentCapabilityTool,
  type SubagentToolResponse
} from "@jingler/core"
import { Effect, JSONSchema, Schema } from "effect"
import type { AgentRuntimeContext } from "../agent/agent-runtime.js"
import type {
  ToolRegistry,
  ToolResultEnvelope,
  ToolRisk
} from "../tools/tool-registry.js"

const MAX_BODY_BYTES = 1024 * 1024
const PARENT_ONLY_TOOLS = new Set([
  "jingler_ask_question",
  "jingler_save_draft_plan",
  "jingler_submit_plan"
])
const READ_ONLY_AGENTS = new Set(["advisor", "oracle", "reviewer"])
const SAFE_AGENT_NAME = /^[a-z][a-z0-9-]*$/u

export interface SubagentParentSpec {
  readonly role: AgentRole
  readonly mode: RuntimeMode
  readonly targetCapabilities: { readonly targetId: string }
}

interface RegisteredChild {
  readonly parentPiSessionId: string
  readonly agent: string
  readonly role: AgentRole
  readonly mode: RuntimeMode
  readonly registry: ToolRegistry
  readonly context: AgentRuntimeContext
}

export interface RegisterSubagentParentInput {
  readonly parentPiSessionId: string
  readonly agents: ReadonlyArray<string>
  readonly spec: SubagentParentSpec
  readonly registry: ToolRegistry
  readonly context: AgentRuntimeContext
}

const json = <Value>(
  response: import("node:http").ServerResponse,
  status: number,
  value: Value
): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  })
  response.end(JSON.stringify(value))
}

const responseFrom = (result: ToolResultEnvelope): SubagentToolResponse => ({
  version: SUBAGENT_CAPABILITY_VERSION,
  status: result.status,
  value: result.value === null || result.value === undefined
    ? null
    : Schema.decodeUnknownSync(SubagentJsonValue)(
        JSON.parse(JSON.stringify(result.value))
      ),
  preview: result.preview,
  error: result.error
})

const childExecutionProfile = (
  spec: SubagentParentSpec,
  agent: string
): { readonly role: AgentRole; readonly mode: RuntimeMode } =>
  READ_ONLY_AGENTS.has(agent)
    ? { role: "review", mode: "read-only" }
    : { role: spec.role, mode: spec.mode }

const childTools = (
  registry: ToolRegistry,
  role: AgentRole,
  mode: RuntimeMode
): ReadonlyArray<SubagentCapabilityTool> =>
  registry
    .capabilitiesFor(role, mode)
    .filter((tool) => !PARENT_ONLY_TOOLS.has(tool.id))
    .map((tool) => {
      const schema = registry.inputSchemaFor(tool.id)
      if (schema === null) {
        throw new Error(`Active child tool has no input schema: ${tool.id}`)
      }
      let inputSchema: SubagentToolInputSchema
      try {
        const providerSchema =
          registry.providerInputSchemaFor(tool.id) ?? JSONSchema.make(schema)
        inputSchema = Schema.decodeUnknownSync(SubagentToolInputSchema)(
          typeof providerSchema === "object" &&
            providerSchema !== null &&
            !Array.isArray(providerSchema)
            ? { ...providerSchema, type: "object" }
            : providerSchema
        )
      } catch (cause) {
        throw new Error(`Active child tool has an unsupported input schema: ${tool.id}`, {
          cause
        })
      }
      return {
        id: tool.id,
        description: tool.description,
        inputSchema,
        risk: registry.riskFor(tool.id) ?? "read"
      }
    })

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.byteLength
    if (length > MAX_BODY_BYTES) throw new Error("request-too-large")
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export class SubagentCapabilityBroker {
  readonly #children = new Map<string, RegisteredChild>()
  readonly #parentTokens = new Map<string, Set<string>>()
  #server: Server | null = null
  #endpoint: string | null = null

  async start(): Promise<string> {
    if (this.#endpoint !== null) return this.#endpoint
    this.#server = createServer((request, response) => {
      void this.#handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject)
      this.#server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = this.#server.address()
    if (!address || typeof address === "string") {
      await this.close()
      throw new Error("Subagent capability broker did not bind a TCP port")
    }
    this.#endpoint = `http://127.0.0.1:${address.port}/v1/subagent-tool`
    return this.#endpoint
  }

  async register(
    input: RegisterSubagentParentInput
  ): Promise<ReadonlyArray<SubagentCapability>> {
    const endpoint = await this.start()
    const agents = [...new Set(input.agents)]
    if (agents.length === 0 || agents.some((agent) => !SAFE_AGENT_NAME.test(agent))) {
      throw new Error("Subagent capability registration requires safe agent names")
    }
    this.unregister(input.parentPiSessionId)
    const tokens = new Set<string>()
    const capabilities = agents.map((agent) => {
      const token = randomBytes(32).toString("base64url")
      const profile = childExecutionProfile(input.spec, agent)
      this.#children.set(token, {
        parentPiSessionId: input.parentPiSessionId,
        agent,
        role: profile.role,
        mode: profile.mode,
        registry: input.registry,
        context: input.context
      })
      tokens.add(token)
      return {
        version: SUBAGENT_CAPABILITY_VERSION,
        endpoint,
        token,
        parentPiSessionId: input.parentPiSessionId,
        agent,
        targetId: input.spec.targetCapabilities.targetId,
        role: profile.role,
        mode: profile.mode,
        tools: childTools(input.registry, profile.role, profile.mode)
      } satisfies SubagentCapability
    })
    this.#parentTokens.set(input.parentPiSessionId, tokens)
    return capabilities
  }

  unregister(parentPiSessionId: string): void {
    const tokens = this.#parentTokens.get(parentPiSessionId)
    if (tokens) {
      for (const token of tokens) this.#children.delete(token)
    }
    this.#parentTokens.delete(parentPiSessionId)
  }

  async close(): Promise<void> {
    this.#children.clear()
    this.#parentTokens.clear()
    this.#endpoint = null
    const server = this.#server
    this.#server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  async #handle(
    request: IncomingMessage,
    response: import("node:http").ServerResponse
  ): Promise<void> {
    if (request.method !== "POST" || request.url !== "/v1/subagent-tool") {
      json(response, 404, { error: "not-found" })
      return
    }
    try {
      const decoded = Schema.decodeUnknownSync(
        Schema.parseJson(SubagentToolRequest)
      )(await readBody(request), { onExcessProperty: "error" })
      const child = this.#children.get(decoded.token)
      if (!child || child.parentPiSessionId !== decoded.parentPiSessionId) {
        json(response, 403, { error: "forbidden" })
        return
      }
      const risk: ToolRisk | null = child.registry.riskFor(decoded.toolId)
      if (risk === null) {
        json(response, 403, { error: "unknown-tool" })
        return
      }
      const execution = {
        id: decoded.toolId,
        arguments: decoded.arguments,
        role: child.role,
        mode: child.mode,
        callId: decoded.callId,
        idempotencyKey: decoded.callId
      } as const
      const permitted = risk === "read"
        ? "allow"
        : await Effect.runPromise(
            child.context.canUseTool({ toolId: decoded.toolId, risk })
          )
      const result = await Effect.runPromise(
        permitted === "allow"
          ? child.registry.execute(execution)
          : child.registry.deny(execution)
      )
      json(response, 200, responseFrom(result))
    } catch (error) {
      json(response, error instanceof SyntaxError ? 400 : 422, {
        error: error instanceof Error ? error.message : "invalid-request"
      })
    }
  }
}
