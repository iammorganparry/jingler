import type { AgentRole, FileChangeSet, RuntimeMode } from "@jingler/core"
import type { PromptToolCapability } from "../prompt/prompt-compiler.js"
import { Effect, Either, Schema } from "effect"

export type ToolRisk = "read" | "network" | "mutate" | "execute"
export type ToolIdempotency = "safe" | "keyed" | "unsafe"

export interface ToolProgress {
  readonly message: string
  readonly completed: number | null
  readonly total: number | null
}

export interface ToolArtifactReference {
  readonly id: string
  readonly byteLength: number
}

export interface ToolResultEnvelope {
  readonly status: "success" | "error" | "cancelled"
  readonly value: unknown | null
  readonly preview: string | null
  readonly artifact: ToolArtifactReference | null
  readonly error: { readonly code: ToolErrorCode; readonly message: string; readonly retryable: boolean } | null
  readonly fileChanges?: FileChangeSet
}

export type ToolErrorCode =
  | "invalid-input"
  | "forbidden"
  | "cancelled"
  | "timed-out"
  | "execution-failed"
  | "artifact-required"

export class ToolError extends Error {
  readonly code: ToolErrorCode
  readonly retryable: boolean

  constructor(code: ToolErrorCode, message: string, retryable = false) {
    super(message)
    this.name = "ToolError"
    this.code = code
    this.retryable = retryable
  }
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal
  readonly idempotencyKey: string | null
  readonly progress: (progress: ToolProgress) => void
}

export interface ToolDefinition<Input, Encoded = Input> {
  readonly id: string
  readonly version: string
  readonly description: string
  readonly input: Schema.Schema<Input, Encoded>
  readonly risk: ToolRisk
  readonly roles: ReadonlyArray<AgentRole>
  readonly modes: ReadonlyArray<RuntimeMode>
  readonly timeoutMs: number
  readonly outputBudget: number
  readonly cancellable: boolean
  readonly idempotency: ToolIdempotency
  readonly execute: (input: Input, context: ToolExecutionContext) => Promise<unknown>
}

type AnyToolDefinition = ToolDefinition<unknown, unknown>

export interface ToolRegistryOptions {
  readonly writeArtifact?: (toolId: string, content: string) => Promise<ToolArtifactReference>
  readonly observer?: ToolExecutionObserver
}

export interface ToolExecutionRequest {
  readonly id: string
  readonly arguments: unknown
  readonly role: AgentRole
  readonly mode: RuntimeMode
  readonly signal?: AbortSignal
  readonly idempotencyKey?: string | null
  readonly callId?: string
  readonly progress?: (progress: ToolProgress) => void
}

export interface ToolExecutionObserver {
  readonly started: (
    request: ToolExecutionRequest,
    risk: ToolRisk
  ) => Effect.Effect<unknown, ToolError>
  readonly settled: (
    request: ToolExecutionRequest,
    risk: ToolRisk,
    state: unknown,
    result: ToolResultEnvelope
  ) => Effect.Effect<FileChangeSet, ToolError>
}

const readOnlyRole = (role: AgentRole): boolean => role === "plan" || role === "review"
const mutatingRisk = (risk: ToolRisk): boolean => risk === "mutate" || risk === "execute"

const allowed = (tool: AnyToolDefinition, role: AgentRole, mode: RuntimeMode): boolean =>
  tool.roles.includes(role) &&
  tool.modes.includes(mode) &&
  !(readOnlyRole(role) && mutatingRisk(tool.risk)) &&
  !(mode === "read-only" && mutatingRisk(tool.risk))

const errorEnvelope = (error: ToolError): ToolResultEnvelope => ({
  status: error.code === "cancelled" ? "cancelled" : "error",
  value: null,
  preview: null,
  artifact: null,
  error: { code: error.code, message: error.message, retryable: error.retryable }
})

const abortError = (signal: AbortSignal): ToolError =>
  new ToolError(signal.reason === "timeout" ? "timed-out" : "cancelled", signal.reason === "timeout" ? "Tool timed out" : "Tool cancelled", true)

const validateExecution = (
  tool: AnyToolDefinition,
  input: ToolExecutionRequest
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly result: ToolResultEnvelope } => {
  if (!allowed(tool, input.role, input.mode)) {
    return { ok: false, result: errorEnvelope(new ToolError("forbidden", `Tool is unavailable in ${input.role}/${input.mode}`)) }
  }
  if (tool.idempotency === "keyed" && !input.idempotencyKey) {
    return { ok: false, result: errorEnvelope(new ToolError("invalid-input", "Tool requires an idempotency key")) }
  }
  const decoded = Schema.decodeUnknownEither(tool.input)(input.arguments)
  return Either.isLeft(decoded)
    ? { ok: false, result: errorEnvelope(new ToolError("invalid-input", "Tool input failed validation")) }
    : { ok: true, value: decoded.right }
}

const startObservation = async (
  options: ToolRegistryOptions,
  input: ToolExecutionRequest,
  tool: AnyToolDefinition
): Promise<unknown> => {
  if (!(options.observer && mutatingRisk(tool.risk))) return null
  return Effect.runPromise(options.observer.started(input, tool.risk))
}

interface SettleObservationInput {
  readonly options: ToolRegistryOptions
  readonly request: ToolExecutionRequest
  readonly tool: AnyToolDefinition
  readonly state: unknown
  readonly result: ToolResultEnvelope
}

const settleObservation = async (
  input: SettleObservationInput
): Promise<ToolResultEnvelope> => {
  const { options, request, tool, state, result } = input
  if (!(options.observer && mutatingRisk(tool.risk))) return result
  const changes = await Effect.runPromise(
    options.observer.settled(request, tool.risk, state, result)
  )
  return { ...result, fileChanges: changes }
}

const executeDefinition = async (
  options: ToolRegistryOptions,
  tool: AnyToolDefinition,
  value: unknown,
  input: ToolExecutionRequest
): Promise<ToolResultEnvelope> => {
  if (input.signal?.aborted) return errorEnvelope(abortError(input.signal))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort("timeout"), tool.timeoutMs)
  const onAbort = (): void =>
    controller.abort(input.signal?.reason ?? "cancelled")
  if (tool.cancellable)
    input.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const result = await Promise.race([
      tool.execute(value, {
        signal: controller.signal,
        idempotencyKey: input.idempotencyKey ?? null,
        progress: input.progress ?? (() => undefined)
      }),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(abortError(controller.signal)),
          { once: true }
        )
      )
    ])
    const serialized = JSON.stringify(result) ?? "null"
    if (serialized.length <= tool.outputBudget) {
      return {
        status: "success",
        value: result,
        preview: null,
        artifact: null,
        error: null
      }
    }
    if (!options.writeArtifact) {
      return errorEnvelope(
        new ToolError("artifact-required", "Tool output exceeded its budget")
      )
    }
    const artifact = await options.writeArtifact(tool.id, serialized)
    return {
      status: "success",
      value: null,
      preview: serialized.slice(0, tool.outputBudget),
      artifact,
      error: null
    }
  } catch (error) {
    return errorEnvelope(
      error instanceof ToolError
        ? error
        : new ToolError(
            "execution-failed",
            error instanceof Error ? error.message : "Tool execution failed"
          )
    )
  } finally {
    clearTimeout(timeout)
    if (tool.cancellable) input.signal?.removeEventListener("abort", onAbort)
  }
}

export class ToolRegistry {
  readonly #tools = new Map<string, AnyToolDefinition>()
  readonly #options: ToolRegistryOptions

  constructor(options: ToolRegistryOptions = {}) {
    this.#options = options
  }

  register<Input, Encoded>(definition: ToolDefinition<Input, Encoded>): void {
    if (this.#tools.has(definition.id)) throw new Error(`duplicate tool id: ${definition.id}`)
    if (definition.timeoutMs <= 0 || definition.outputBudget <= 0) {
      throw new Error(`invalid limits for tool: ${definition.id}`)
    }
    this.#tools.set(definition.id, definition as AnyToolDefinition)
  }

  capabilitiesFor(role: AgentRole, mode: RuntimeMode): ReadonlyArray<PromptToolCapability> {
    return [...this.#tools.values()]
      .filter((tool) => allowed(tool, role, mode))
      .map(({ id, version, description }) => ({ id, version, description }))
  }

  riskFor(id: string): ToolRisk | null {
    return this.#tools.get(id)?.risk ?? null
  }

  hasMutatingTools(role: AgentRole, mode: RuntimeMode): boolean {
    return [...this.#tools.values()].some(
      (tool) => allowed(tool, role, mode) && mutatingRisk(tool.risk)
    )
  }

  execute(input: ToolExecutionRequest): Effect.Effect<ToolResultEnvelope> {
    return Effect.promise(() => this.#execute(input))
  }

  async #execute(input: ToolExecutionRequest): Promise<ToolResultEnvelope> {
    const tool = this.#tools.get(input.id)
    if (!tool) return errorEnvelope(new ToolError("forbidden", `Unknown tool: ${input.id}`))
    const validated = validateExecution(tool, input)
    if (!validated.ok) return validated.result
    if (mutatingRisk(tool.risk) && !this.#options.observer) {
      return errorEnvelope(
        new ToolError(
          "forbidden",
          "Mutation tracking is unavailable; the tool was not executed"
        )
      )
    }

    try {
      const observation = await startObservation(this.#options, input, tool)
      const result = await executeDefinition(
        this.#options,
        tool,
        validated.value,
        input
      )
      return await settleObservation({
        options: this.#options,
        request: input,
        tool,
        state: observation,
        result
      })
    } catch (error) {
      return errorEnvelope(
        error instanceof ToolError
          ? error
          : new ToolError("execution-failed", "Mutation tracking failed")
      )
    }
  }
}
