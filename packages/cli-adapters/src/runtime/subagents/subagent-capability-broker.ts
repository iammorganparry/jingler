import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import {
  SUBAGENT_CAPABILITY_VERSION,
  SubagentJsonValue,
  SubagentToolInputSchema,
  SubagentToolRequest,
  type AgentRole,
  type RuntimeMode,
  type SubagentCapability,
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

export interface SubagentParentSpec {
  readonly role: AgentRole
  readonly mode: RuntimeMode
  readonly targetCapabilities: { readonly targetId: string }
}

interface RegisteredParent {
  readonly parentPiSessionId: string
  readonly token: string
  readonly spec: SubagentParentSpec
  readonly registry: ToolRegistry
  readonly context: AgentRuntimeContext
}

export interface RegisterSubagentParentInput {
  readonly parentPiSessionId: string
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
  parent: RegisteredParent,
  childAgent: string
): { readonly role: AgentRole; readonly mode: RuntimeMode } =>
  READ_ONLY_AGENTS.has(childAgent)
    ? { role: "review", mode: "read-only" }
    : { role: parent.spec.role, mode: parent.spec.mode }

const safeTokenMatch = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
}

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
  readonly #parents = new Map<string, RegisteredParent>()
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
  ): Promise<SubagentCapability> {
    const endpoint = await this.start()
    const token = randomBytes(32).toString("base64url")
    this.#parents.set(input.parentPiSessionId, { ...input, token })
    return {
      version: SUBAGENT_CAPABILITY_VERSION,
      endpoint,
      token,
      parentPiSessionId: input.parentPiSessionId,
      targetId: input.spec.targetCapabilities.targetId,
      role: input.spec.role,
      mode: input.spec.mode,
      tools: input.registry
        .capabilitiesFor(input.spec.role, input.spec.mode)
        .filter((tool) => !PARENT_ONLY_TOOLS.has(tool.id))
        .map((tool) => {
          const schema = input.registry.inputSchemaFor(tool.id)
          if (schema === null) {
            throw new Error(`Active child tool has no input schema: ${tool.id}`)
          }
          const inputSchema = Schema.decodeUnknownSync(SubagentToolInputSchema)(
            input.registry.providerInputSchemaFor(tool.id) ?? JSONSchema.make(schema)
          )
          return {
            id: tool.id,
            description: tool.description,
            inputSchema,
            risk: input.registry.riskFor(tool.id) ?? "read"
          }
        })
    }
  }

  unregister(parentPiSessionId: string): void {
    this.#parents.delete(parentPiSessionId)
  }

  async close(): Promise<void> {
    this.#parents.clear()
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
      const parent = this.#parents.get(decoded.parentPiSessionId)
      if (!parent || !safeTokenMatch(parent.token, decoded.token)) {
        json(response, 403, { error: "forbidden" })
        return
      }
      const profile = childExecutionProfile(parent, decoded.childAgent)
      const risk: ToolRisk | null = parent.registry.riskFor(decoded.toolId)
      if (risk === null) {
        json(response, 403, { error: "unknown-tool" })
        return
      }
      const execution = {
        id: decoded.toolId,
        arguments: decoded.arguments,
        role: profile.role,
        mode: profile.mode,
        callId: decoded.callId,
        idempotencyKey: decoded.callId
      } as const
      const permitted = risk === "read"
        ? "allow"
        : await Effect.runPromise(
            parent.context.canUseTool({ toolId: decoded.toolId, risk })
          )
      const result = await Effect.runPromise(
        permitted === "allow"
          ? parent.registry.execute(execution)
          : parent.registry.deny(execution)
      )
      json(response, 200, responseFrom(result))
    } catch (error) {
      json(response, error instanceof SyntaxError ? 400 : 422, {
        error: error instanceof Error ? error.message : "invalid-request"
      })
    }
  }
}
