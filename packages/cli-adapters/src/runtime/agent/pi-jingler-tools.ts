import {
  PlanPrd,
  QuestionRequest,
  WebSearchError,
  WebSearchQuery
} from "@jingler/core"
import { Effect, Either, Schema } from "effect"
import {
  type McpToolBridgeError,
  jinglerMcpSources,
  registerMcpTools,
  type McpToolClientFactory,
  type JinglerMcpAttachments
} from "../tools/mcp-tools.js"
import {
  ToolError,
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
  service: WebSearchServiceShape,
  context: AgentRuntimeContext,
  offerSetup: boolean
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
    // Interactive first-use setup shares this invocation. Keep it bounded but
    // long enough for an operator response; route-level network calls remain 30s.
    timeoutMs: 15 * 60_000,
    outputBudget: 32_000,
    cancellable: true,
    idempotency: "safe",
    execute: (input, toolContext) =>
      Effect.runPromise(
        Effect.either(service.search(input, toolContext.signal).pipe(
          Effect.catchTag("WebSearchError", (error) => {
            if (
              error.reason !== "setup-required" ||
              !offerSetup ||
              service.chooseSetup === undefined
            ) return Effect.fail(error)
            return context.askQuestion({
              id: "web-search-setup",
              questions: [{
                header: "Web search",
                question: "Set up a search provider, or skip and use available fallbacks?",
                options: [
                  { label: "Set up EXA", description: "Select EXA, then add its key in Settings → General." },
                  { label: "Set up Firecrawl", description: "Select Firecrawl, then add its key in Settings → General." },
                  { label: "Skip", description: "Use model-native or attached desktop browser fallback." }
                ],
                multiSelect: false
              }]
            }).pipe(
              Effect.flatMap((answers) => {
                const selected = answers[0]?.selected[0]
                if (selected === "Skip") {
                  return service.chooseSetup!(null).pipe(
                    Effect.zipRight(service.search(input, toolContext.signal))
                  )
                }
                const provider = selected === "Set up EXA"
                  ? "exa"
                  : selected === "Set up Firecrawl"
                    ? "firecrawl"
                    : null
                if (provider === null) return Effect.fail(error)
                return service.chooseSetup!(provider).pipe(
                  Effect.zipRight(Effect.fail(new WebSearchError({
                    reason: "setup-required",
                    message: `Add the ${provider === "exa" ? "EXA" : "Firecrawl"} key in Settings → General, then retry search`,
                    retryable: false
                  })))
                )
              })
            )
          })
        )),
        { signal: toolContext.signal }
      ).then((result) => {
        if (Either.isRight(result)) return result.right
        const error = result.left
        throw new ToolError(
          error.reason === "cancelled" ? "cancelled" : "execution-failed",
          error.message,
          error.retryable
        )
      })
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
    if (input.webSearch) {
      registerWebSearchTool(
        registry,
        input.webSearch,
        input.context,
        input.mcp?.browser != null
      )
    }
    const mcpSources = input.mcp ? jinglerMcpSources(input.mcp) : []
    if (mcpSources.length > 0) {
      const report = yield* (input.mcpClientFactory
        ? registerMcpTools(registry, mcpSources, input.mcpClientFactory)
        : registerMcpTools(registry, mcpSources))
      registry.setMcpHealth(report.health)
    }
    if (
      input.context.memoryAttachmentStatus === "failed" &&
      !registry.mcpHealth().some(({ name }) => name === "jingler-memory")
    ) {
      registry.setMcpHealth([
        ...registry.mcpHealth(),
        { name: "jingler-memory", status: "failed" }
      ])
    }
    return registry
  })
