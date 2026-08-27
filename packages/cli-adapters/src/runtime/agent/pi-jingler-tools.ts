import {
  ExplanationPayload,
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
import { registerCodeIntelligenceTools } from "../tools/code-intelligence-tools.js"
import { registerStructuralCodeTools } from "../tools/structural-code-tools.js"
import type { AgentRuntimeContext } from "./agent-runtime.js"

const roles = ["conversation", "plan", "plan-execution", "background"] as const
const modes = ["ask", "accept-edits", "auto", "plan", "read-only"] as const

const controlTool = <Input, Encoded>(
  input: Pick<
    ToolDefinition<Input, Encoded>,
    "id" | "description" | "input" | "roles" | "execute" | "providerInputSchema"
  >
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
  if (context.listPeerAgents !== undefined) {
    registry.register(
      controlTool({
        id: "jingler_list_agents",
        description: "List peer top-level agents in this session, including their current work and touched files.",
        input: Schema.Struct({}),
        providerInputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false
        },
        roles,
        execute: () => Effect.runPromise(context.listPeerAgents!())
      })
    )
  }
  if (context.messagePeerAgent !== undefined) {
    registry.register(
      controlTool({
        id: "jingler_message_agent",
        description: "Send an attributed direct message to another top-level agent in this session.",
        input: Schema.Struct({ targetChatId: Schema.String, text: Schema.String }),
        roles,
        execute: ({ targetChatId, text }) =>
          Effect.runPromise(context.messagePeerAgent!(targetChatId, text))
      })
    )
  }
  registry.register(
    controlTool({
      id: "jingler_publish_explanation",
      description: "Publish a focused visual explanation in the session's Explanation view.",
      input: Schema.Struct({ explanation: ExplanationPayload }),
      roles: ["conversation", "plan", "plan-execution"],
      execute: ({ explanation }) => Effect.runPromise(context.publishExplanation?.(explanation) ?? Effect.void)
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
  /**
   * The CURRENT turn's attachments, read at each tool call. Registration is
   * once per pi session but per-run attachments (the browser lease) rotate
   * every turn — see `McpToolSource.resolveServer`.
   */
  readonly liveMcp?: () => JinglerMcpAttachments | undefined
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
    registerCodeIntelligenceTools(registry, input.cwd)
    registerStructuralCodeTools(registry, input.cwd)
    if (input.webSearch) {
      registerWebSearchTool(
        registry,
        input.webSearch,
        input.context,
        input.mcp?.browser != null
      )
    }
    const mcpSources = input.mcp ? jinglerMcpSources(input.mcp, input.liveMcp) : []
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
