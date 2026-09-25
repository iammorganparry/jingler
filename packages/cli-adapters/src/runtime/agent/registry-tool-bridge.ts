import type { AgentRunSpec } from "@jingler/core"
import { Effect, Option, Schema } from "effect"
import type { ToolExecutionRequest, ToolRegistry, ToolResultEnvelope } from "../tools/tool-registry.js"
import type { AgentRuntimeContext } from "./agent-runtime.js"

export interface RegistryToolResult {
  readonly content: Array<{ type: "text"; text: string }>
  readonly details: ToolResultEnvelope
}

/** `command_execute`'s result value; its output reads as text, not JSON. */
const CommandResult = Schema.Struct({
  command: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String
})
const decodeCommandResult = Schema.decodeUnknownOption(CommandResult)

const maxRenderedResult = 32_000

const renderResult = (result: ToolResultEnvelope): string => {
  let value: string
  if (result.error) {
    value = `${result.error.code}: ${result.error.message}`
  } else if (result.preview !== null) {
    value = result.preview
  } else if (result.value === null || result.value === undefined) {
    value = result.status
  } else {
    const command = Option.getOrNull(decodeCommandResult(result.value))
    if (command === null) {
      value = JSON.stringify(result.value)
    } else {
      const output = [command.stdout, command.stderr]
        .filter((stream) => stream.trim().length > 0)
        .join("\n")
        .trimEnd()
      value = output.length > 0 ? output : `Command exited ${command.exitCode}`
    }
  }
  return value.slice(0, maxRenderedResult)
}

interface RegistryToolExecution {
  readonly registry: ToolRegistry
  readonly spec: Pick<AgentRunSpec, "role" | "mode">
  readonly context: AgentRuntimeContext
  readonly id: string
  readonly toolCallId: string
  readonly parameters: unknown
  readonly signal: AbortSignal | undefined
  readonly allowed: boolean
  readonly onUpdate:
    | ((result: RegistryToolResult) => void)
    | undefined
}

export const executeRegistryTool = async (
  input: RegistryToolExecution
): Promise<RegistryToolResult> => {
  const { registry, spec, context, id, toolCallId, parameters, signal, allowed, onUpdate } =
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
  if (!allowed) {
    const denied = await Effect.runPromise(registry.deny(request))
    return { content: [{ type: "text", text: renderResult(denied) }], details: denied }
  }
  const requiresPermission = risk !== null && risk !== "read"
  const permitted = requiresPermission
    ? await Effect.runPromise(
        context.canUseTool({ toolId: id, risk }),
        { signal }
      )
    : "allow"
  if (permitted !== "allow") {
    const denied = await Effect.runPromise(registry.deny(request))
    return { content: [{ type: "text", text: renderResult(denied) }], details: denied }
  }
  const result = await Effect.runPromise(registry.execute(request))
  return { content: [{ type: "text", text: renderResult(result) }], details: result }
}
