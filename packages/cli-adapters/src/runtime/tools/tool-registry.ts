import type {
  AgentRole,
  FileChangeSet,
  RuntimeDiagnosticMcpHealth,
  RuntimeMode
} from "@jingler/core"
import type { PromptToolCapability } from "../prompt/prompt-compiler.js"
import type { WorktreeSnapshot } from "../file-changes/file-change-tracker.js"
import { Effect, Either, Schema } from "effect"

export type ToolRisk = "read" | "network" | "mutate" | "execute"
export type ToolIdempotency = "safe" | "keyed" | "unsafe"

const ProviderToolId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.pattern(/^[A-Za-z0-9_-]+$/u)
)
const isProviderToolId = Schema.is(ProviderToolId)

export interface ToolProgress {
  readonly message: string
  readonly completed: number | null
  readonly total: number | null
}

export interface ToolArtifactReference {
  readonly id: string
  readonly byteLength: number
}

/** JSON Schema subset accepted by pi for object-valued tool parameters. */
export interface ToolProviderInputSchema {
  readonly $schema?: string
  readonly type: "object"
  readonly properties?: Readonly<Record<string, object>>
  readonly required?: ReadonlyArray<string>
  readonly additionalProperties?: boolean
}

export interface ToolResultEnvelope {
  readonly status: "success" | "error" | "cancelled"
  readonly value: unknown | null
  readonly preview: string | null
  readonly artifact: ToolArtifactReference | null
  readonly error: { readonly code: ToolErrorCode; readonly message: string; readonly retryable: boolean } | null
  /** Cited accepted memory surfaced alongside, without changing the tool value. */
  readonly advisory?: string
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

export interface PluginToolOrigin {
  readonly kind: "plugin"
  readonly pluginId: string
  readonly toolsetId: string
}

export type ToolOrigin = PluginToolOrigin

export interface ToolSuccessfulResult<Value = unknown> {
  readonly toolId: string
  readonly callId: string | null
  readonly risk: ToolRisk
  readonly origin: ToolOrigin | null
  /** Present only when the serialized value fit the tool's declared output budget. */
  readonly value: Value
}

export interface ToolDefinition<Input, Encoded = Input> {
  readonly id: string
  readonly version: string
  readonly description: string
  /** Optional trusted source metadata attached by Jingler, never by model input. */
  readonly origin?: ToolOrigin
  readonly input: Schema.Schema<Input, Encoded>
  /** Exact provider-visible schema when execution uses an external validator. */
  readonly providerInputSchema?: ToolProviderInputSchema
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

export interface ToolMemoryFailure {
  readonly signature: string
  readonly toolId: string
  readonly message: string
}

export interface ToolMemoryHooks {
  readonly recall: (
    request: ToolExecutionRequest,
    risk: ToolRisk
  ) => Promise<string | null>
  readonly recordFailure: (
    request: ToolExecutionRequest,
    risk: ToolRisk,
    result: ToolResultEnvelope
  ) => Promise<void>
  readonly failures: () => ReadonlyArray<ToolMemoryFailure>
}

export interface ToolRegistryOptions {
  readonly writeArtifact?: (toolId: string, content: string) => Promise<ToolArtifactReference>
  readonly observer?: ToolExecutionObserver
  readonly memory?: ToolMemoryHooks
  /** Observe settled, bounded successful values without changing the tool outcome. */
  readonly onSuccessfulResult?: (result: ToolSuccessfulResult) => void | Promise<void>
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
  ) => Effect.Effect<WorktreeSnapshot, ToolError>
  readonly settled: (
    request: ToolExecutionRequest,
    risk: ToolRisk,
    state: WorktreeSnapshot,
    result: ToolResultEnvelope
  ) => Effect.Effect<FileChangeSet, ToolError>
  readonly denied?: (
    request: ToolExecutionRequest,
    risk: ToolRisk
  ) => Effect.Effect<void, ToolError>
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
): Promise<WorktreeSnapshot | null> => {
  if (!(options.observer && mutatingRisk(tool.risk))) return null
  return Effect.runPromise(options.observer.started(input, tool.risk))
}

interface SettleObservationInput {
  readonly options: ToolRegistryOptions
  readonly request: ToolExecutionRequest
  readonly tool: AnyToolDefinition
  readonly state: WorktreeSnapshot | null
  readonly result: ToolResultEnvelope
}

const settleObservation = async (
  input: SettleObservationInput
): Promise<ToolResultEnvelope> => {
  const { options, request, tool, state, result } = input
  if (!(options.observer && mutatingRisk(tool.risk))) return result
  if (state === null) {
    throw new ToolError("execution-failed", "Mutation receipt state is missing")
  }
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

const recallToolMemory = async (
  options: ToolRegistryOptions,
  request: ToolExecutionRequest,
  risk: ToolRisk
): Promise<string | null> => {
  if (!options.memory || !mutatingRisk(risk)) return null
  try {
    return await options.memory.recall(request, risk)
  } catch {
    return null
  }
}

const toolMemoryPreflight = (advisory: string): ToolResultEnvelope => ({
  status: "error",
  value: null,
  preview: "Execution paused so accepted tool memory can be reviewed.",
  artifact: null,
  error: {
    code: "forbidden",
    message: "Review the cited tool memory, then retry or revise this call.",
    retryable: true
  },
  advisory
})

const recordToolMemoryFailure = async (
  options: ToolRegistryOptions,
  request: ToolExecutionRequest,
  risk: ToolRisk,
  result: ToolResultEnvelope
): Promise<void> => {
  if (!options.memory || result.status === "success") return
  try {
    await options.memory.recordFailure(request, risk, result)
  } catch {
    // Memory is advisory: recording may never alter the tool result.
  }
}

const publishSuccessfulResult = async (
  options: ToolRegistryOptions,
  request: ToolExecutionRequest,
  tool: AnyToolDefinition,
  result: ToolResultEnvelope
): Promise<void> => {
  if (!options.onSuccessfulResult || result.status !== "success" || result.artifact !== null) return
  try {
    await options.onSuccessfulResult({
      toolId: tool.id,
      callId: request.callId ?? request.idempotencyKey ?? null,
      risk: tool.risk,
      origin: tool.origin ?? null,
      value: result.value
    })
  } catch {
    // Observers are downstream bookkeeping. A failed observer must not make a
    // completed external mutation look retryable to the model.
  }
}

export class ToolRegistry {
  readonly #tools = new Map<string, AnyToolDefinition>()
  readonly #options: ToolRegistryOptions
  #mcpHealth: ReadonlyArray<RuntimeDiagnosticMcpHealth> = []
  #mutatingExecutions = 0
  #memoryAdvisories = 0
  #memoryProposals = 0
  #memoryWorkflowPolls = 0

  constructor(options: ToolRegistryOptions = {}) {
    this.#options = options
  }

  register<Input, Encoded>(definition: ToolDefinition<Input, Encoded>): void {
    if (!isProviderToolId(definition.id)) {
      throw new Error(`invalid tool id: ${definition.id}`)
    }
    if (this.#tools.has(definition.id)) throw new Error(`duplicate tool id: ${definition.id}`)
    if (definition.timeoutMs <= 0 || definition.outputBudget <= 0) {
      throw new Error(`invalid limits for tool: ${definition.id}`)
    }
    this.#tools.set(definition.id, definition as AnyToolDefinition)
  }

  canRegister(id: string): boolean {
    return isProviderToolId(id) && !this.#tools.has(id)
  }

  setMcpHealth(health: ReadonlyArray<RuntimeDiagnosticMcpHealth>): void {
    this.#mcpHealth = [...health]
  }

  mcpHealth(): ReadonlyArray<RuntimeDiagnosticMcpHealth> {
    return this.#mcpHealth
  }

  toolMemoryFailures(): ReadonlyArray<ToolMemoryFailure> {
    return this.#options.memory?.failures() ?? []
  }

  memoryTelemetry(): {
    readonly mutatingExecutions: number
    readonly advisories: number
    readonly proposals: number
    readonly workflowPolls: number
    readonly failureCandidates: number
  } {
    return {
      mutatingExecutions: this.#mutatingExecutions,
      advisories: this.#memoryAdvisories,
      proposals: this.#memoryProposals,
      workflowPolls: this.#memoryWorkflowPolls,
      failureCandidates: this.toolMemoryFailures().length
    }
  }

  memoryReflectionPrompt(role: AgentRole): string | null {
    const memoryActive = [...this.#tools.keys()].some((id) =>
      id.startsWith("mcp__jingler-memory__memory_propose")
    )
    if (
      !memoryActive ||
      role === "plan" ||
      role === "review" ||
      role === "context-digest" ||
      this.#mutatingExecutions === 0 ||
      this.#memoryProposals > 0
    ) return null
    const failures = this.toolMemoryFailures().slice(0, 3)
    return [
      "<memory-reflection>",
      "The visible turn is complete. Silently perform the bounded team-memory reflection now.",
      "Use only the attached memory tools. Emit no prose and do not modify the workspace.",
      "Propose at most three durable, non-sensitive learnings; a valid result may be no proposal.",
      "Search/read accepted pages before proposing, and poll every returned workflowId to a terminal state.",
      ...(failures.length === 0
        ? []
        : [
            "Tool failures worth considering (redacted, bounded evidence — not automatically durable):",
            ...failures.map(({ signature, message }) => `- ${signature}: ${message}`)
          ]),
      "</memory-reflection>"
    ].join("\n")
  }

  capabilitiesFor(role: AgentRole, mode: RuntimeMode): ReadonlyArray<PromptToolCapability> {
    return [...this.#tools.values()]
      .filter((tool) => allowed(tool, role, mode))
      .map(({ id, version, description }) => ({ id, version, description }))
  }

  riskFor(id: string): ToolRisk | null {
    return this.#tools.get(id)?.risk ?? null
  }

  inputSchemaFor(id: string): Schema.Schema<unknown, unknown> | null {
    return this.#tools.get(id)?.input ?? null
  }

  providerInputSchemaFor(id: string): ToolProviderInputSchema | null {
    return this.#tools.get(id)?.providerInputSchema ?? null
  }

  hasMutatingTools(role: AgentRole, mode: RuntimeMode): boolean {
    return [...this.#tools.values()].some(
      (tool) => allowed(tool, role, mode) && mutatingRisk(tool.risk)
    )
  }

  execute(input: ToolExecutionRequest): Effect.Effect<ToolResultEnvelope> {
    return Effect.promise(() => this.#execute(input))
  }

  deny(input: ToolExecutionRequest): Effect.Effect<ToolResultEnvelope> {
    return Effect.promise(() => this.#deny(input))
  }

  async #deny(input: ToolExecutionRequest): Promise<ToolResultEnvelope> {
    const tool = this.#tools.get(input.id)
    if (!tool) return errorEnvelope(new ToolError("forbidden", `Unknown tool: ${input.id}`))
    if (mutatingRisk(tool.risk) && this.#options.observer?.denied) {
      try {
        await Effect.runPromise(this.#options.observer.denied(input, tool.risk))
      } catch (error) {
        return errorEnvelope(
          error instanceof ToolError
            ? error
            : new ToolError("execution-failed", "Failed to journal permission denial")
        )
      }
    }
    return errorEnvelope(new ToolError("forbidden", "Permission denied"))
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

    const advisory = await recallToolMemory(this.#options, input, tool.risk)
    if (advisory !== null) {
      this.#memoryAdvisories += 1
      return toolMemoryPreflight(advisory)
    }
    let result: ToolResultEnvelope
    try {
      const observation = await startObservation(this.#options, input, tool)
      const executed = await executeDefinition(
        this.#options,
        tool,
        validated.value,
        input
      )
      result = await settleObservation({
        options: this.#options,
        request: input,
        tool,
        state: observation,
        result: executed
      })
    } catch (error) {
      result = errorEnvelope(
        error instanceof ToolError
          ? error
          : new ToolError("execution-failed", "Mutation tracking failed")
      )
    }
    if (mutatingRisk(tool.risk)) this.#mutatingExecutions += 1
    await publishSuccessfulResult(this.#options, input, tool, result)
    if (
      input.id.startsWith("mcp__jingler-memory__memory_propose") &&
      result.status === "success"
    ) this.#memoryProposals += 1
    if (
      input.id.startsWith("mcp__jingler-memory__memory_workflow_status") &&
      result.status === "success"
    ) this.#memoryWorkflowPolls += 1
    await recordToolMemoryFailure(this.#options, input, tool.risk, result)
    return result
  }
}
