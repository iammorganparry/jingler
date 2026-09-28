import { randomUUID } from "node:crypto"
import { JinglerSubagentName, type AgentRunSpec } from "@jingler/core"
import { Schema } from "effect"
import type { SubagentDelegationRequest } from "pi-subagents/delegation"
import type {
  SubagentDelegationResponse,
  SubagentDelegationUpdate
} from "pi-subagents/delegation"
import { codeReadModes, codeReadRoles, ToolError, type ToolExecutionContext, type ToolRegistry } from "../tools/tool-registry.js"

const NativeSubagentInput = Schema.Struct({
  agent: JinglerSubagentName,
  task: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100_000)),
  context: Schema.optional(Schema.Literal("fresh", "fork")),
  thinking: Schema.optional(Schema.Literal("off", "minimal", "low", "medium", "high", "xhigh", "max")),
  timeoutMs: Schema.optional(Schema.Number.pipe(Schema.greaterThan(0))),
  toolBudget: Schema.optional(Schema.Struct({
    soft: Schema.optional(Schema.Number.pipe(Schema.greaterThan(0))),
    hard: Schema.Number.pipe(Schema.greaterThan(0)),
    block: Schema.optional(Schema.Union(Schema.Array(Schema.String), Schema.Literal("*")))
  })),
  artifacts: Schema.optional(Schema.Boolean)
})
type NativeSubagentInput = typeof NativeSubagentInput.Type

const toolBudgetFor = (
  input: NativeSubagentInput["toolBudget"]
): SubagentDelegationRequest["toolBudget"] => {
  if (input === undefined) return undefined
  return {
    hard: input.hard,
    ...(input.soft === undefined ? {} : { soft: input.soft }),
    ...(input.block === "*"
      ? { block: "*" as const }
      : Array.isArray(input.block)
        ? { block: Array.from(input.block) }
        : {})
  }
}

const requestFor = (
  input: NativeSubagentInput,
  spec: AgentRunSpec,
  requestId: string
): SubagentDelegationRequest => ({
  requestId,
  ownerRunId: spec.runId,
  nodeId: requestId,
  agent: input.agent,
  task: input.task,
  context: input.context ?? "fresh",
  cwd: spec.cwd,
  ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
  ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  ...(input.toolBudget === undefined ? {} : { toolBudget: toolBudgetFor(input.toolBudget) }),
  ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
  result: { kind: "text" }
})

export type NativeSubagentDelegate = (
  request: SubagentDelegationRequest,
  signal: AbortSignal,
  onUpdate?: (update: SubagentDelegationUpdate) => void
) => Promise<SubagentDelegationResponse>

const executeDelegation = async (
  delegate: NativeSubagentDelegate,
  spec: AgentRunSpec,
  input: NativeSubagentInput,
  context: ToolExecutionContext
) => {
  const response = await delegate(
    requestFor(input, spec, randomUUID()),
    context.signal,
    (update) => context.progress({
      message: update.currentTool ?? update.recentOutput ?? "Subagent working",
      completed: null,
      total: null
    })
  )
  if (response.status !== "completed") {
    throw new ToolError("execution-failed", response.error ?? `Subagent ${response.status}`)
  }
  return {
    runId: response.runId ?? null,
    agent: response.agent ?? input.agent,
    model: response.model ?? null,
    result: response.result?.kind === "text" ? response.result.text : response.result?.value ?? null,
    usage: response.usage ?? null
  }
}

/**
 * Native harnesses expose one deterministic foreground delegation contract.
 * Claude uses the bundled PI extension; Codex and OpenCode use fresh native
 * child sessions with the same role/model settings and no nested delegation.
 */
export const registerNativeSubagentTool = (
  registry: ToolRegistry,
  spec: AgentRunSpec,
  delegate: NativeSubagentDelegate
): void => {
  if (!registry.canRegister("subagent")) return
  registry.register({
    id: "subagent",
    version: "1",
    description: "Delegate one bounded code, research, review, or scouting task to the configured foreground child. Use it for material manual work; keep trivial work local.",
    input: NativeSubagentInput,
    risk: "read",
    roles: codeReadRoles,
    modes: codeReadModes,
    timeoutMs: 30 * 60_000,
    outputBudget: 128_000,
    cancellable: true,
    idempotency: "unsafe",
    execute: (input, context) => executeDelegation(delegate, spec, input, context)
  })
}
