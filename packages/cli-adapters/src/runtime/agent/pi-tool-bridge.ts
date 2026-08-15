import { Type } from "@earendil-works/pi-ai"
import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition as PiToolDefinition
} from "@earendil-works/pi-coding-agent"
import type { PiRunSpec } from "@jingler/core"
import { Effect, JSONSchema, Option, Schema } from "effect"
import type {
  ToolExecutionRequest,
  ToolRegistry,
  ToolResultEnvelope
} from "../tools/tool-registry.js"
import type { AgentRuntimeContext } from "./agent-runtime.js"

/** `command_execute`'s result value; its output reads as text, not JSON. */
const CommandResult = Schema.Struct({
  command: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String
})
const decodeCommandResult = Schema.decodeUnknownOption(CommandResult)

const renderResult = (result: ToolResultEnvelope): string => {
  if (result.error) return `${result.error.code}: ${result.error.message}`
  if (result.preview !== null) return result.preview
  if (result.value === null) return result.status
  const command = Option.getOrNull(decodeCommandResult(result.value))
  if (command !== null) {
    const output = [command.stdout, command.stderr]
      .filter((stream) => stream.trim().length > 0)
      .join("\n")
      .trimEnd()
    return output.length > 0 ? output : `Command exited ${command.exitCode}`
  }
  return JSON.stringify(result.value)
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
  const request: ToolExecutionRequest = {
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
  }
  const requiresPermission = risk !== null && risk !== "read"
  const permitted = requiresPermission
    ? await Effect.runPromise(
        context.canUseTool({ toolId: id, risk })
      )
    : "allow"
  if (permitted !== "allow") {
    const denied = await Effect.runPromise(registry.deny(request))
    return { content: [{ type: "text", text: renderResult(denied) }], details: denied }
  }
  const result = await Effect.runPromise(registry.execute(request))
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
