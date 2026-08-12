import { Type } from "@earendil-works/pi-ai"
import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition as PiToolDefinition
} from "@earendil-works/pi-coding-agent"
import type { PiRunSpec } from "@jingler/core"
import { Effect, JSONSchema } from "effect"
import type { ToolRegistry, ToolResultEnvelope } from "../tools/tool-registry.js"
import type { AgentRuntimeContext } from "./agent-runtime.js"

const renderResult = (result: ToolResultEnvelope): string => {
  if (result.error) return `${result.error.code}: ${result.error.message}`
  if (result.preview !== null) return result.preview
  return result.value === null ? result.status : JSON.stringify(result.value)
}

interface PiToolExecution {
  readonly registry: ToolRegistry
  readonly spec: Pick<PiRunSpec, "role" | "mode">
  readonly context: AgentRuntimeContext
  readonly id: string
  readonly toolCallId: string
  readonly parameters: unknown
  readonly signal: AbortSignal | undefined
  readonly onUpdate:
    | ((result: AgentToolResult<ToolResultEnvelope>) => void)
    | undefined
}

const executeTool = async (
  input: PiToolExecution
): Promise<AgentToolResult<ToolResultEnvelope>> => {
  const { registry, spec, context, id, toolCallId, parameters, signal, onUpdate } =
    input
  const risk = registry.riskFor(id)
  const requiresPermission = risk !== null && risk !== "read"
  const permitted = requiresPermission
    ? await Effect.runPromise(
        context.canUseTool({ toolId: id, risk })
      )
    : "allow"
  if (permitted !== "allow") {
    const denied: ToolResultEnvelope = {
      status: "error",
      value: null,
      preview: null,
      artifact: null,
      error: { code: "forbidden", message: "Permission denied", retryable: false }
    }
    return { content: [{ type: "text", text: renderResult(denied) }], details: denied }
  }
  const result = await Effect.runPromise(
    registry.execute({
      id,
      arguments: parameters,
      role: spec.role,
      mode: spec.mode,
      signal,
      callId: toolCallId,
      idempotencyKey: toolCallId,
      progress: (progress) =>
        onUpdate?.({
          content: [{ type: "text", text: progress.message }],
          details: {
            status: "success",
            value: progress,
            preview: progress.message,
            artifact: null,
            error: null
          }
        })
    })
  )
  return { content: [{ type: "text", text: renderResult(result) }], details: result }
}

/** Adapt the exact active Jingler registry into pi custom tools. */
export const createPiTools = (
  registry: ToolRegistry,
  spec: Pick<PiRunSpec, "role" | "mode">,
  context: AgentRuntimeContext
): ReadonlyArray<PiToolDefinition> =>
  registry.capabilitiesFor(spec.role, spec.mode).map((capability) => {
    const input = registry.inputSchemaFor(capability.id)
    if (input === null) {
      throw new Error(`Active tool has no input schema: ${capability.id}`)
    }
    const providerInput = registry.providerInputSchemaFor(capability.id)
    return defineTool({
      name: capability.id,
      label: capability.id,
      description: capability.description,
      promptSnippet: capability.description,
      parameters: Type.Unsafe(providerInput ?? JSONSchema.make(input)),
      execute: (toolCallId, parameters, signal, onUpdate) =>
        executeTool({
          registry,
          spec,
          context,
          id: capability.id,
          toolCallId,
          parameters,
          signal,
          onUpdate
        })
    })
  })
