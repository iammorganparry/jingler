import { PlanPrd, QuestionRequest, WebSearchQuery } from "@jingler/core"
import { Effect, Schema } from "effect"
import {
  type McpToolBridgeError,
  jinglerMcpSources,
  registerMcpTools,
  type McpToolClientFactory,
  type JinglerMcpAttachments
} from "../tools/mcp-tools.js"
import {
  ToolRegistry,
  type ToolDefinition,
  type ToolRegistryOptions
} from "../tools/tool-registry.js"
import {
  registerWorkspaceInspectionTools,
  type WorkspaceInspectionPort
} from "../tools/workspace-tools.js"
import type { WebSearchServiceShape } from "../../web-search.js"
import type { AgentRuntimeContext } from "./agent-runtime.js"

const roles = ["conversation", "plan", "plan-execution", "background"] as const
const modes = ["ask", "accept-edits", "auto", "plan", "read-only"] as const

const controlTool = <Input, Encoded>(
  input: Pick<ToolDefinition<Input, Encoded>, "id" | "description" | "input" | "roles" | "execute">
): ToolDefinition<Input, Encoded> => ({
  ...input,
  version: "1",
  risk: "read",
  modes,
  timeoutMs: 24 * 60 * 60 * 1_000,
  outputBudget: 16_000,
  cancellable: true,
  idempotency: "safe"
})

/** Build run-scoped control tools so callbacks cannot leak between conversations. */
export const createJinglerControlTools = (
  context: AgentRuntimeContext,
  registry = new ToolRegistry()
): ToolRegistry => {
  registry.register(
    controlTool({
      id: "jingler_ask_question",
      description: "Ask the operator one or more structured questions.",
      input: QuestionRequest,
      roles,
      execute: (request) => Effect.runPromise(context.askQuestion(request))
    })
  )
  registry.register(
    controlTool({
      id: "jingler_save_draft_plan",
      description: "Save the current structured plan draft without requesting approval.",
      input: Schema.Struct({ plan: PlanPrd }),
      roles: ["plan"],
      execute: ({ plan }) => Effect.runPromise(context.saveDraftPlan(plan))
    })
  )
  registry.register(
    controlTool({
      id: "jingler_submit_plan",
      description: "Submit the structured plan for operator review and approval.",
      input: Schema.Struct({ plan: PlanPrd }),
      roles: ["conversation", "plan", "plan-execution"],
      execute: ({ plan }) => Effect.runPromise(context.proposePlan(plan))
    })
  )
  return registry
}

export const registerWebSearchTool = (
  registry: ToolRegistry,
  service: WebSearchServiceShape
): void => {
  registry.register({
    id: "web_search",
    version: "1",
    description:
      "Search the web for research and return bounded cited results. Do not use browser QA tools for general research.",
    input: WebSearchQuery,
    risk: "network",
    roles: ["conversation", "plan", "plan-execution", "review", "context-digest", "background"],
    modes,
    timeoutMs: 30_000,
    outputBudget: 32_000,
    cancellable: true,
    idempotency: "safe",
    execute: (input, context) =>
      Effect.runPromise(service.search(input, context.signal))
  })
}

export interface JinglerToolRegistryInput {
  readonly context: AgentRuntimeContext
  readonly cwd: string
  readonly workspace?: WorkspaceInspectionPort
  readonly webSearch?: WebSearchServiceShape
  readonly mcp?: JinglerMcpAttachments
  readonly mcpClientFactory?: McpToolClientFactory
  readonly registryOptions?: ToolRegistryOptions
}

/** Compose one run-scoped registry from Jingler-owned capability sources. */
export const createJinglerTools = (
  input: JinglerToolRegistryInput
): Effect.Effect<ToolRegistry, McpToolBridgeError> =>
  Effect.gen(function* () {
    const registry = createJinglerControlTools(
      input.context,
      new ToolRegistry(input.registryOptions)
    )
    if (input.workspace) {
      registerWorkspaceInspectionTools(registry, input.cwd, input.workspace)
    }
    if (input.webSearch) registerWebSearchTool(registry, input.webSearch)
    const mcpSources = input.mcp ? jinglerMcpSources(input.mcp) : []
    if (mcpSources.length > 0) {
      const report = yield* (input.mcpClientFactory
        ? registerMcpTools(registry, mcpSources, input.mcpClientFactory)
        : registerMcpTools(registry, mcpSources))
      registry.setMcpHealth(report.health)
    }
    return registry
  })
