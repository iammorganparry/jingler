import { randomUUID } from "node:crypto"
import { JinglerSubagentName, type AgentRunSpec } from "@jingler/core"
import { Schema } from "effect"
import type { SubagentDelegationRequest } from "pi-subagents/delegation"
import type {
  SubagentDelegationResponse,
  SubagentDelegationUpdate
} from "pi-subagents/delegation"
import { codeReadModes, codeReadRoles, ToolError, type ToolExecutionContext, type ToolRegistry } from "../tools/tool-registry.js"
import type {
  PiSubagentAsyncDelegate,
  PiSubagentAsyncSpawnRequest
} from "./pi-subagent-rpc.js"

const Task = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100_000))
const Context = Schema.Literal("fresh", "fork")
const Thinking = Schema.Literal("off", "minimal", "low", "medium", "high", "xhigh", "max")
const Timeout = Schema.Number.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(2_147_483_647))

const ForegroundNativeSubagentInput = Schema.Struct({
  agent: JinglerSubagentName,
  task: Task,
  async: Schema.optional(Schema.Literal(false)),
  context: Schema.optional(Context),
  thinking: Schema.optional(Thinking),
  timeoutMs: Schema.optional(Schema.Number.pipe(Schema.greaterThan(0))),
  toolBudget: Schema.optional(Schema.Struct({
    soft: Schema.optional(Schema.Number.pipe(Schema.greaterThan(0))),
    hard: Schema.Number.pipe(Schema.greaterThan(0)),
    block: Schema.optional(Schema.Union(Schema.Array(Schema.String), Schema.Literal("*")))
  })),
  artifacts: Schema.optional(Schema.Boolean)
})
type ForegroundNativeSubagentInput = typeof ForegroundNativeSubagentInput.Type

const AsyncTask = Schema.Struct({
  agent: JinglerSubagentName,
  task: Task,
  context: Schema.optional(Context),
  thinking: Schema.optional(Thinking),
  timeoutMs: Schema.optional(Timeout)
})
type AsyncTask = typeof AsyncTask.Type

const AsyncSingleInput = Schema.Struct({
  async: Schema.Literal(true),
  agent: JinglerSubagentName,
  task: Task,
  context: Schema.optional(Context),
  thinking: Schema.optional(Thinking),
  timeoutMs: Schema.optional(Timeout)
})

const AsyncWorkflowInput = Schema.Struct({
  async: Schema.Literal(true),
  workflow: Schema.Struct({
    mode: Schema.Literal("parallel", "chain"),
    tasks: Schema.Array(AsyncTask).pipe(Schema.minItems(1), Schema.maxItems(8))
  })
})

type NativeSubagentInput =
  | typeof ForegroundNativeSubagentInput.Type
  | typeof AsyncSingleInput.Type
  | typeof AsyncWorkflowInput.Type

const toolBudgetFor = (
  input: ForegroundNativeSubagentInput["toolBudget"]
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
  input: ForegroundNativeSubagentInput,
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
  input: ForegroundNativeSubagentInput,
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

const asyncAgent = (
  agent: string,
  names: Readonly<Record<string, string>> | undefined
): string => {
  if (names === undefined) return agent
  const resolved = names[agent]
  if (resolved === undefined) {
    throw new ToolError("execution-failed", `Background ${agent} is unavailable for this native runtime`)
  }
  return resolved
}

const taskOptions = (
  task: AsyncTask,
  names?: Readonly<Record<string, string>>
): Record<string, unknown> => ({
  agent: asyncAgent(task.agent, names),
  task: task.task,
  context: task.context ?? "fresh",
  ...(task.thinking === undefined ? {} : { thinking: task.thinking }),
  ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs })
})

const parallelWorkflow = (
  tasks: ReadonlyArray<AsyncTask>,
  names?: Readonly<Record<string, string>>
): string =>
  `return runs.all(${JSON.stringify(tasks.map((task, index) => ({
    key: `step-${index + 1}`,
    ...taskOptions(task, names)
  })))});`

const chainWorkflow = (
  tasks: ReadonlyArray<AsyncTask>,
  names?: Readonly<Record<string, string>>
): string => {
  const lines = ["const results = [];"]
  tasks.forEach((task, index) => {
    const key = `step-${index + 1}`
    const variable = `step${index + 1}`
    const { task: prompt, ...options } = taskOptions(task, names)
    const chainedPrompt = index === 0
      ? JSON.stringify(prompt)
      : `${JSON.stringify(prompt)} + "\\n\\nPrevious result:\\n" + step${index}.output`
    lines.push(
      `const ${variable} = await runs.run(${JSON.stringify(key)}, { ...${JSON.stringify(options)}, task: ${chainedPrompt} });`,
      `results.push(${variable});`
    )
  })
  lines.push("return results;")
  return lines.join("\n")
}

const asyncRequest = (
  spec: AgentRunSpec,
  input: typeof AsyncSingleInput.Type | typeof AsyncWorkflowInput.Type,
  names?: Readonly<Record<string, string>>
): PiSubagentAsyncSpawnRequest => {
  if ("workflow" in input) {
    return {
      cwd: spec.cwd,
      workflowScript: input.workflow.mode === "parallel"
        ? parallelWorkflow(input.workflow.tasks, names)
        : chainWorkflow(input.workflow.tasks, names)
    }
  }
  return {
    cwd: spec.cwd,
    agent: asyncAgent(input.agent, names),
    task: input.task,
    context: input.context ?? "fresh",
    ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
  }
}

const executeAsync = async (
  delegate: PiSubagentAsyncDelegate | undefined,
  spec: AgentRunSpec,
  input: typeof AsyncSingleInput.Type | typeof AsyncWorkflowInput.Type,
  context: ToolExecutionContext,
  names?: Readonly<Record<string, string>>
) => {
  if (delegate === undefined) {
    throw new ToolError("execution-failed", "Background subagents are unavailable for this session")
  }
  const result = await delegate(asyncRequest(spec, input, names), context.signal)
  return {
    status: "running",
    runId: result.runId,
    asyncDir: result.asyncDir
  }
}

/** One native-harness contract: foreground leaves plus bounded detached workflows. */
export const registerNativeSubagentTool = (
  registry: ToolRegistry,
  spec: AgentRunSpec,
  delegate: NativeSubagentDelegate,
  asyncDelegate?: PiSubagentAsyncDelegate,
  asyncAgentNames?: Readonly<Record<string, string>>
): void => {
  if (!registry.canRegister("subagent")) return
  registry.register({
    id: "subagent",
    version: "2",
    description: "Delegate one foreground task or start a bounded background single, parallel, or chain workflow. Use it for material manual work; keep trivial work local.",
    input: Schema.Union(
      ForegroundNativeSubagentInput,
      AsyncSingleInput,
      AsyncWorkflowInput
    ),
    risk: "read",
    roles: codeReadRoles,
    modes: codeReadModes,
    timeoutMs: 30 * 60_000,
    outputBudget: 128_000,
    cancellable: true,
    idempotency: "unsafe",
    execute: (input: NativeSubagentInput, context) =>
      input.async === true
        ? executeAsync(asyncDelegate, spec, input, context, asyncAgentNames)
        : executeDelegation(delegate, spec, input, context)
  })
}
