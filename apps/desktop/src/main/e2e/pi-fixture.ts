import { readFileSync } from "node:fs"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Context as PiContext,
  type FauxResponseStep,
  type Provider
} from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import {
  AuthKind,
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  ProviderId,
  ProviderModelId,
  ReasoningEffort,
  type PlanPrd,
  type ModelCertification
} from "@jingler/core"
import { Option, Schema } from "effect"
import {
  planTaskProgressFingerprint,
  scriptedPlanPrd,
  type DiscoveredProviderModel
} from "@jingler/cli-adapters"
import { scriptedPiScenarioResponses } from "@jingler/cli-adapters/runtime/certification/pi-scenario-fixture"
import { E2E_PI_CONNECTION_ID, E2E_PI_MODEL_ID, E2E_PI_PROVIDER_ID } from "./fixture-identity.js"
import {
  E2E_BACKGROUND_TOOL,
  E2E_HELD_SUBAGENTS_TOOL,
  E2E_HOLD_TOOL,
  E2E_REVIEW_PAUSE_TOOL,
  type E2eBackgroundKind
} from "./pi-fixture-tools.js"

const E2ePiFixture = Schema.Struct({
  scenarioId: Schema.String,
  authRoute: AuthKind,
  reasoning: Schema.optional(Schema.Array(ReasoningEffort)),
  seedConnection: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  staleCertification: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  modelCount: Schema.optionalWith(Schema.Int.pipe(Schema.between(1, 100)), {
    default: () => 1
  })
})

export type E2ePiFixture = Schema.Schema.Type<typeof E2ePiFixture>

const PROVIDER_ID = Schema.decodeUnknownSync(ProviderId)(E2E_PI_PROVIDER_ID)
const MODEL_ID = Schema.decodeUnknownSync(ProviderModelId)(E2E_PI_MODEL_ID)
const SUBMIT_PLAN_TOOL = "jingler_submit_plan"
const QUESTION_TOOL = "jingler_ask_question"
const READ_TOOL = "workspace_read_file"
const WRITE_TOOL = "workspace_write"
const RENAME_TOOL = "workspace_rename"
const COMMAND_TOOL = "command_execute"
const MEMORY_PROPOSE_TOOL = "mcp__jingler-memory__memory_propose"
const MEMORY_WORKFLOW_TOOL = "mcp__jingler-memory__memory_workflow_status"
const E2E_CONTEXT_WINDOW = 1_000_000
const observedRouteFor = (authRoute: E2ePiFixture["authRoute"]): string =>
  `e2e-${authRoute}`
const COMPACTION_THINKING = "context ".repeat(17_500)
const DIGEST_REPLY = `\`\`\`json
{
  "goal": "Add rate limiting to the refund endpoint",
  "decisions": ["Reused the token bucket in lib/ratelimit.ts rather than adding a dependency"],
  "filesTouched": ["src/routes/billing.ts"],
  "openThreads": ["The 429 test still needs writing"],
  "preferences": ["Prefers Effect over raw async"]
}
\`\`\``
const MODERN_CONFIG =
  "export const mode = 'modern'\nexport const retries = 2\nexport const timeout = 1_000\n"
const MEMORY_MARKDOWN =
  "# Refund rate limiting\n\nRefund retries share one team limiter so bursts cannot multiply across workers."

const MemoryToolResult = Schema.Struct({
  structuredContent: Schema.optional(
    Schema.Struct({
      data: Schema.optional(
        Schema.Struct({
          workflowId: Schema.optional(Schema.String),
          status: Schema.optional(Schema.String),
          conflicts: Schema.optional(
            Schema.Array(
              Schema.Struct({
                pageId: Schema.String,
                expectedBaseRevisionId: Schema.String,
                currentHeadRevisionId: Schema.String
              })
            )
          )
        })
      )
    })
  )
})

/** Test fixtures are accepted only in an explicitly marked Electron e2e process. */
export const loadE2ePiFixture = (): E2ePiFixture | null => {
  const path = process.env.JINGLER_E2E_PI_FIXTURE
  if (process.env.JINGLER_E2E !== "1" || path === undefined) return null
  return Schema.decodeUnknownSync(E2ePiFixture)(JSON.parse(readFileSync(path, "utf8")))
}

export const e2eProviderConnection = (fixture: E2ePiFixture) =>
  Schema.decodeUnknownSync(ProviderConnection)({
    id: E2E_PI_CONNECTION_ID,
    providerId: PROVIDER_ID,
    authKind: fixture.authRoute,
    account: { fingerprint: "e2e-account", displayLabel: "Electron fixture" },
    targetId: "desktop",
    status: "authenticated",
    subscription: {
      entitlement: "active",
      planLabel: fixture.authRoute === "api-key" ? null : "Test subscription",
      expiresAt: null,
      quotaLabel: null,
      rateLimitLabel: null,
      confirmedBillingRoute: fixture.authRoute === "api-key" ? "api" : "subscription",
      observedRoute: observedRouteFor(fixture.authRoute)
    },
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z"
  })

const e2eDiscoveredModel = (
  fixture: E2ePiFixture,
  providerId: ProviderId,
  index: number
): DiscoveredProviderModel => ({
  providerId,
  id: Schema.decodeUnknownSync(ProviderModelId)(
    `${providerId}/${index === 0 ? "eval-model" : `eval-model-${index + 1}`}`
  ),
  label: `Deterministic pi model ${index + 1}`,
  capabilities: {
    contextWindow: E2E_CONTEXT_WINDOW,
    reasoning: fixture.reasoning ?? [],
    reasoningCanDisable: true,
    vision: false
  }
})

export const e2eDiscoveredModels = (
  fixture: E2ePiFixture,
  providerId: ProviderId = PROVIDER_ID
): ReadonlyArray<DiscoveredProviderModel> =>
  Array.from({ length: fixture.modelCount }, (_, index) =>
    e2eDiscoveredModel(fixture, providerId, index)
  )

export const e2eCertification = (
  fixture: E2ePiFixture,
  providerId: ProviderId = PROVIDER_ID,
  modelId: ProviderModelId = MODEL_ID
): ModelCertification => ({
  providerId,
  modelId,
  authRoute: {
    kind: fixture.authRoute,
    observedRoute: observedRouteFor(fixture.authRoute),
    subscription: fixture.authRoute !== "api-key",
    entitlementConfirmed: true,
    apiBillingFallbackObserved: false
  },
  versions: fixture.staleCertification
    ? { ...CURRENT_RUNTIME_CONTRACTS, tools: "stale" }
    : CURRENT_RUNTIME_CONTRACTS,
  provenance: "local",
  capabilityProfiles: ["core", "managed-resources"],
  results: [
    {
      scenarioId: fixture.scenarioId,
      status: "passed",
      failures: [],
      durationMs: 1,
      tokens: 0,
      costUsd: 0
    }
  ],
  certifiedAt: "2026-08-10T00:00:00.000Z"
})

const latestOperatorText = (context: PiContext): string => {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index]
    if (message?.role !== "user") continue
    return typeof message.content === "string"
      ? message.content
      : message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
  }
  return ""
}

const operatorText = (context: PiContext): ReadonlyArray<string> =>
  context.messages.flatMap((message) => {
    if (message.role !== "user") return []
    return [
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
    ]
  })

const toolResultText = (message: PiContext["messages"][number]): string =>
  message.role === "toolResult"
    ? message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
    : ""

const recentToolResultCount = (context: PiContext, toolName: string): number => {
  let count = 0
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index]
    if (message?.role === "user") break
    if (message?.role === "toolResult" && message.toolName === toolName) count += 1
  }
  return count
}

const memoryToolData = (context: PiContext) => {
  const message = context.messages.at(-1)
  if (message?.role !== "toolResult") return null
  return Option.match(
    Schema.decodeUnknownOption(Schema.parseJson(MemoryToolResult))(toolResultText(message)),
    {
      onNone: () => null,
      onSome: (result) => result.structuredContent?.data ?? null
    }
  )
}

const callTool = (
  name: string,
  input: Parameters<typeof fauxToolCall>[1],
  id: string
): ReturnType<typeof fauxAssistantMessage> =>
  fauxAssistantMessage(fauxToolCall(name, input, { id }), {
    stopReason: "toolUse"
  })

const planTaskMarkers = (plan: PlanPrd): ReadonlyArray<string> =>
  plan.stages.flatMap((stage) =>
    (stage.tasks ?? []).map(
      (task) =>
        `PLAN_TASK stage=${stage.id} fingerprint=${planTaskProgressFingerprint(stage)} task=${task.id} status=completed`
    )
  )

const planResultMarkers = (plan: PlanPrd): ReadonlyArray<string> =>
  plan.stages.flatMap((stage) =>
    stage.acceptance.map(
      (criterion) =>
        `PLAN_RESULT criterion=${criterion.id} status=passed evidence=Deterministic pi completed and verified the planned work.`
    )
  )

const browserUrlFrom = (context: PiContext): string => {
  const match = latestOperatorText(context).match(/\[\[browser-url=([^\]]+)\]\]/)
  return match?.[1] ?? "about:blank"
}

const backgroundKindFrom = (context: PiContext): E2eBackgroundKind | null => {
  const prompt = latestOperatorText(context)
  if (prompt.includes("[[background-agent]]")) return "agent"
  if (prompt.includes("[[background-completes]]")) return "complete"
  if (prompt.includes("[[background")) return "watch"
  return null
}

const backgroundResponse = (
  context: PiContext,
  kind: E2eBackgroundKind
): ReturnType<typeof fauxAssistantMessage> => {
  const lastMessage = context.messages.at(-1)
  if (lastMessage?.role !== "toolResult" || lastMessage.toolName !== E2E_BACKGROUND_TOOL) {
    return fauxAssistantMessage(fauxToolCall(E2E_BACKGROUND_TOOL, { kind }), {
      stopReason: "toolUse"
    })
  }
  return fauxAssistantMessage(
    kind === "agent"
      ? "Delegated the survey to a background agent."
      : "Started a watcher in the background."
  )
}

const heldSubagentsResponse = (
  context: PiContext
): ReturnType<typeof fauxAssistantMessage> | null => {
  const prompts = operatorText(context)
  if (!prompts.some((prompt) => prompt.includes("[[held-subagents]]"))) return null

  const prompt = latestOperatorText(context)
  const steered = !prompt.includes("[[held-subagents]]")
  const resultsAfterLatestPrompt = recentToolResultCount(context, E2E_HELD_SUBAGENTS_TOOL)
  if (!steered) {
    const toolCall = fauxToolCall(
      E2E_HELD_SUBAGENTS_TOOL,
      { phase: resultsAfterLatestPrompt === 0 ? "start" : "wait" },
      { id: `held-subagents-${resultsAfterLatestPrompt}` }
    )
    return fauxAssistantMessage(
      resultsAfterLatestPrompt === 0
        ? [fauxText("Delegated to two agents."), toolCall]
        : toolCall,
      { stopReason: "toolUse" }
    )
  }
  if (resultsAfterLatestPrompt === 0) {
    return fauxAssistantMessage(
      [
        fauxText(`Noted: ${prompt}`),
        fauxToolCall(E2E_HELD_SUBAGENTS_TOOL, { phase: "wait" }, { id: "held-steer-1" })
      ],
      { stopReason: "toolUse" }
    )
  }
  if (resultsAfterLatestPrompt === 1) {
    return callTool(
      E2E_HELD_SUBAGENTS_TOOL,
      { phase: "settle" },
      "held-steer-settle"
    )
  }
  return fauxAssistantMessage("Both agents reported back.")
}

const memoryResponse = (
  context: PiContext
): ReturnType<typeof fauxAssistantMessage> | null => {
  const prompt = operatorText(context).find(
    (text) =>
      text.includes("[[memory-propose]]") || text.includes("[[memory-propose-conflict]]")
  )
  if (prompt === undefined) return null

  const lastMessage = context.messages.at(-1)
  if (lastMessage?.role !== "toolResult") {
    return callTool(
      MEMORY_PROPOSE_TOOL,
      prompt.includes("[[memory-propose-conflict]]")
        ? {
            pageId: "alpha",
            baseRevisionId: "revision:alpha:1",
            markdown: "# Alpha memory\n\nA stale update must never overwrite revision two."
          }
        : {
            pageId: "shared-learning",
            baseRevisionId: "new",
            markdown: MEMORY_MARKDOWN
          },
      "memory-propose"
    )
  }

  const data = memoryToolData(context)
  if (lastMessage.toolName === MEMORY_PROPOSE_TOOL) {
    const conflict = data?.conflicts?.[0]
    if (data?.status === "conflict" && conflict !== undefined) {
      return fauxAssistantMessage(
        `Memory proposal conflict for ${conflict.pageId}: expected ${conflict.expectedBaseRevisionId}; current ${conflict.currentHeadRevisionId}.`
      )
    }
    if (data?.workflowId !== undefined) {
      return callTool(
        MEMORY_WORKFLOW_TOOL,
        { workflowId: data.workflowId },
        "memory-workflow-status"
      )
    }
  }
  return fauxAssistantMessage("Memory proposal workflow completed through pi.")
}

const fileBrowserResponse = (
  context: PiContext
): ReturnType<typeof fauxAssistantMessage> | null => {
  const prompt = latestOperatorText(context)
  const writes = recentToolResultCount(context, WRITE_TOOL)

  if (prompt.includes("[[queue-hold]]")) {
    return fauxAssistantMessage(
      [
        fauxText("Holding the active turn for queue actions."),
        fauxToolCall(E2E_HOLD_TOOL, {}, { id: "queue-hold-1" })
      ],
      { stopReason: "toolUse" }
    )
  }
  if (prompt.includes("[[codex-edit-preview]]")) {
    if (writes === 0) {
      return callTool(WRITE_TOOL, { path: "src/config.ts", content: MODERN_CONFIG }, "codex-edit-1")
    }
    if (writes === 1) {
      return callTool(
        WRITE_TOOL,
        { path: "src/created.ts", content: "export const created = true\n" },
        "codex-create-1"
      )
    }
    return fauxAssistantMessage("Updated and created the configuration files.")
  }
  if (prompt.includes("[[subagent-edit-preview]]")) {
    return writes === 0
      ? callTool(
          WRITE_TOOL,
          { path: "src/delegated.ts", content: "export const delegated = true\n" },
          "subagent-edit-1"
        )
      : fauxAssistantMessage("Delegated file update completed.")
  }
  if (prompt.includes("[[follow-file-move]]")) {
    const renames = recentToolResultCount(context, RENAME_TOOL)
    if (renames === 0) {
      return callTool(
        RENAME_TOOL,
        { from: "src/config.ts", to: "src/settings/config.ts" },
        "follow-move-1"
      )
    }
    return writes === 0
      ? callTool(
          WRITE_TOOL,
          { path: "src/settings/config.ts", content: MODERN_CONFIG },
          "follow-move-write-1"
        )
      : fauxAssistantMessage("Moved and updated the configuration file.")
  }
  if (prompt.includes("[[follow-diff-preview]]")) {
    return writes === 0
      ? callTool(WRITE_TOOL, { path: "src/config.ts", content: MODERN_CONFIG }, "follow-diff-1")
      : fauxAssistantMessage("Updated the configuration mode.")
  }
  return null
}

const mutationResponse = (
  context: PiContext,
  inflateContext = false
): ReturnType<typeof fauxAssistantMessage> => {
  const lastMessage = context.messages.at(-1)
  if (lastMessage?.role !== "toolResult") {
    return fauxAssistantMessage(
      fauxToolCall(WRITE_TOOL, {
        path: "src/routes/billing.ts",
        content: "export const refundRateLimit = { requests: 5, windowMs: 60_000 }\n"
      }),
      { stopReason: "toolUse" }
    )
  }
  if (lastMessage.toolName === WRITE_TOOL) {
    return fauxAssistantMessage(
      fauxToolCall(COMMAND_TOOL, {
        command: "printf '1 passed\\n'"
      }),
      { stopReason: "toolUse" }
    )
  }
  return inflateContext
    ? fauxAssistantMessage([
        fauxThinking(COMPACTION_THINKING),
        fauxText("Implemented rate limiting and verified 1 passed.")
      ])
    : fauxAssistantMessage("Implemented rate limiting and verified 1 passed.")
}

const questionResponse = (context: PiContext): ReturnType<typeof fauxAssistantMessage> => {
  const lastMessage = context.messages.at(-1)
  if (lastMessage?.role !== "toolResult" || lastMessage.toolName !== QUESTION_TOOL) {
    return fauxAssistantMessage(
      fauxToolCall(QUESTION_TOOL, {
        id: "e2e-store-migration",
        questions: [
          {
            question: "Which token strategy should the store use?",
            header: "Strategy",
            multiSelect: false,
            options: [
              {
                label: "Rotating refresh tokens",
                description: "Issue a new refresh token on every use."
              },
              {
                label: "Sliding session",
                description: "Extend one session while it remains active."
              }
            ]
          },
          {
            question: "Which surfaces should adopt the new store?",
            header: "Surfaces",
            multiSelect: true,
            options: [
              {
                label: "HTTP middleware",
                description: "Use the store in API request authentication."
              },
              {
                label: "Background workers",
                description: "Use the store in asynchronous jobs."
              }
            ]
          }
        ]
      }),
      { stopReason: "toolUse" }
    )
  }
  return fauxAssistantMessage("Got it — starting with the selected token strategy and surfaces.")
}

const stormResponse = (context: PiContext): ReturnType<typeof fauxAssistantMessage> => {
  const reads = context.messages.filter(
    (message) => message.role === "toolResult" && message.toolName === READ_TOOL
  ).length
  if (reads >= 4) return fauxAssistantMessage("Scanned four files.")
  return fauxAssistantMessage(fauxToolCall(READ_TOOL, { path: `src/file-${reads + 1}.ts` }), {
    stopReason: "toolUse"
  })
}

const reviewResponse = (context: PiContext): ReturnType<typeof fauxAssistantMessage> => {
  const lastMessage = context.messages.at(-1)
  if (lastMessage?.role !== "toolResult" || lastMessage.toolName !== E2E_REVIEW_PAUSE_TOOL) {
    return fauxAssistantMessage(fauxToolCall(E2E_REVIEW_PAUSE_TOOL, {}), {
      stopReason: "toolUse"
    })
  }
  return fauxAssistantMessage('```json\n{"findings":[]}\n```')
}

const planModeResponse = (context: PiContext): ReturnType<typeof fauxAssistantMessage> => {
  const prompt = latestOperatorText(context)
  const prompts = operatorText(context)
  const originalPlanPrompt = prompts.find((text) => text.includes("[[plan]]")) ?? prompt
  const amended = prompt !== originalPlanPrompt || prompt.includes("[[amendment]]")
  const plan = scriptedPlanPrd("e2e", amended ? 2 : 1, false, amended)
  const lastMessage = context.messages.at(-1)

  if (lastMessage?.role !== "toolResult" || lastMessage.toolName !== SUBMIT_PLAN_TOOL) {
    return fauxAssistantMessage(fauxToolCall(SUBMIT_PLAN_TOOL, { plan }), {
      stopReason: "toolUse"
    })
  }
  if (toolResultText(lastMessage).includes('"_tag":"Revise"')) {
    const revised = scriptedPlanPrd("e2e", 2, false, true)
    return fauxAssistantMessage(fauxToolCall(SUBMIT_PLAN_TOOL, { plan: revised }), {
      stopReason: "toolUse"
    })
  }

  const markers = originalPlanPrompt.includes("[[plan-partial-hold]]")
    ? planTaskMarkers(plan).filter((marker) => marker.includes("stage=s_02 "))
    : [
        "Steps 2, 3 and 5 are done.",
        ...planTaskMarkers(plan),
        ...(originalPlanPrompt.includes("[[plan-needs-verification]]")
          ? []
          : planResultMarkers(plan))
      ]
  return fauxAssistantMessage(markers.join("\n"))
}

const defaultResponse = (context: PiContext): ReturnType<typeof fauxAssistantMessage> => {
  const prompt = latestOperatorText(context)
  if (prompt.includes("[[expect-code-context]]")) {
    return fauxAssistantMessage(
      prompt.includes("<repository-code-references>")
        ? "Received selected diff context."
        : "Selected diff context was missing."
    )
  }
  const fileBrowser = fileBrowserResponse(context)
  if (fileBrowser !== null) return fileBrowser
  const heldSubagents = heldSubagentsResponse(context)
  if (heldSubagents !== null) return heldSubagents
  const memory = memoryResponse(context)
  if (memory !== null) return memory
  if (operatorText(context).some((text) => text.includes("adversarial code reviewer"))) {
    return reviewResponse(context)
  }
  if (operatorText(context).some((text) => text.includes("[[plan]]"))) {
    return planModeResponse(context)
  }
  const backgroundKind = backgroundKindFrom(context)
  if (backgroundKind !== null) return backgroundResponse(context, backgroundKind)
  if (latestOperatorText(context).includes("[[ask]]")) return questionResponse(context)
  if (latestOperatorText(context).includes("[[storm]]")) return stormResponse(context)
  if (latestOperatorText(context).includes("GitHub feedback from")) {
    return recentToolResultCount(context, COMMAND_TOOL) === 0
      ? callTool(
          COMMAND_TOOL,
          { command: "printf 'feedback inspected\\n'" },
          `github-feedback-${operatorText(context).length}`
        )
      : fauxAssistantMessage("Inspected the GitHub feedback through pi.")
  }
  if (latestOperatorText(context).includes("[[offload-local-retry]]")) {
    return recentToolResultCount(context, COMMAND_TOOL) === 0
      ? callTool(
          COMMAND_TOOL,
          { command: "pnpm typecheck" },
          "offload-local-retry-1"
        )
      : fauxAssistantMessage("Explicit local retry completed.")
  }
  if (latestOperatorText(context).includes("[[offload-owned-device]]")) {
    return recentToolResultCount(context, COMMAND_TOOL) === 0
      ? callTool(
          COMMAND_TOOL,
          { command: "node -e \"process.stdout.write('owned device test clean\\\\n')\"" },
          "offload-owned-device-1"
        )
      : fauxAssistantMessage("Tests completed on the selected owned device.")
  }
  if (latestOperatorText(context).includes("[[offload-typecheck]]")) {
    return recentToolResultCount(context, COMMAND_TOOL) === 0
      ? callTool(COMMAND_TOOL, { command: "pnpm typecheck" }, "offload-typecheck-1")
      : fauxAssistantMessage("Typecheck completed on Offload Compute.")
  }
  if (latestOperatorText(context).includes("Add rate limiting")) {
    return mutationResponse(context)
  }
  return fauxAssistantMessage(
    "Completed through deterministic pi. Repository summary: src/routes/billing.ts."
  )
}

const liveWebSearchResponse = (
  context: PiContext
): ReturnType<typeof fauxAssistantMessage> => {
  const lastMessage = context.messages.at(-1)
  if (lastMessage?.role !== "toolResult" || lastMessage.toolName !== "web_search") {
    return callTool(
      "web_search",
      {
        query: "Jingler coding agent research tool",
        maxResults: 3
      },
      "live-web-search"
    )
  }
  const toolResult = toolResultText(lastMessage)
  const route = toolResult.match(/"route"\s*:\s*"([^"]+)"/u)?.[1] ?? "missing"
  const citations = [...toolResult.matchAll(/"url"\s*:\s*"([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((url): url is string => url !== undefined)
  return fauxAssistantMessage(
    `Live WebSearch result: Route: ${route}. Citations: ${citations.join(", ") || "missing"}.`
  )
}

const contextCompactionResponse = (context: PiContext): ReturnType<typeof fauxAssistantMessage> => {
  if (latestOperatorText(context).includes("You are compacting a coding session's context")) {
    return fauxAssistantMessage(
      Array.from({ length: Math.ceil(DIGEST_REPLY.length / 17) }, (_, index) =>
        fauxText(DIGEST_REPLY.slice(index * 17, index * 17 + 17))
      )
    )
  }
  if (latestOperatorText(context).includes("Add rate limiting")) {
    return mutationResponse(context, true)
  }
  return defaultResponse(context)
}

const responsesFor = (fixture: E2ePiFixture): ReadonlyArray<FauxResponseStep> => {
  switch (fixture.scenarioId) {
    case "plan-mode":
      return Array.from({ length: 12 }, () => planModeResponse)
    case "managed-resources":
      return [
        fauxAssistantMessage(fauxToolCall("jingler_load_resource", { id: "managed-skill" }), {
          stopReason: "toolUse"
        }),
        fauxAssistantMessage("Managed skill loaded through pi.")
      ]
    case "memory-recall":
      return [
        fauxAssistantMessage(
          fauxToolCall("mcp__jingler-memory__memory_search", {
            query: "alpha",
            limit: 5
          }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("Completed through deterministic pi.")
      ]
    case "live-web-search":
      return Array.from({ length: 8 }, () => liveWebSearchResponse)
    case "browser-control":
      return [
        (context) =>
          fauxAssistantMessage(
            fauxToolCall("mcp__jingler-browser__navigate", {
              url: browserUrlFrom(context)
            }),
            { stopReason: "toolUse" }
          ),
        fauxAssistantMessage(fauxToolCall("mcp__jingler-browser__read_text", {}), {
          stopReason: "toolUse"
        }),
        fauxAssistantMessage("Browser workflow completed through pi.")
      ]
    case "context-compaction":
      return Array.from({ length: 20 }, () => contextCompactionResponse)
    default:
      return Array.from({ length: 64 }, () => defaultResponse)
  }
}

export const configureE2ePiProvider = (fixture: E2ePiFixture) => {
  const tokenSize =
    fixture.scenarioId === "plan-draft-stream"
      ? { min: 128, max: 128 }
      : fixture.scenarioId === "plan-mode" || fixture.scenarioId === "context-compaction"
        ? { min: 4_096, max: 4_096 }
        : null
  const provider = fauxProvider({
    provider: PROVIDER_ID,
    api: "jingler-e2e-api",
    models: [{ id: "eval-model", contextWindow: E2E_CONTEXT_WINDOW }],
    tokensPerSecond: fixture.scenarioId === "plan-draft-stream" ? 128 : 0,
    ...(tokenSize === null ? {} : { tokenSize })
  })
  provider.setResponses([...responsesFor(fixture)])
  return (runtime: ModelRuntime): void => {
    runtime.registerNativeProvider(provider.provider)
  }
}

export const configureE2eVerificationProvider = (
  providerId: string,
  scenarioId: string,
  authKind: E2ePiFixture["authRoute"]
) => {
  const provider = fauxProvider({
    provider: providerId,
    api: `${providerId}-e2e-verification`,
    models: [{ id: "eval-model", contextWindow: E2E_CONTEXT_WINDOW }],
    tokensPerSecond: 0
  })
  provider.setResponses([...scriptedPiScenarioResponses(scenarioId)])
  const runtimeProvider: Provider =
    authKind === "claude-setup-token" || authKind === "openai-codex-oauth"
      ? {
          ...provider.provider,
          auth: {
            ...provider.provider.auth,
            oauth: {
              name: "Deterministic subscription",
              isSubscription: true,
              login: async () => {
                throw new Error("E2E login is supplied by AuthBroker")
              },
              refresh: async (credential) => credential,
              toAuth: async (credential) => ({ apiKey: credential.access })
            }
          }
        }
      : provider.provider
  return (runtime: ModelRuntime): void => {
    runtime.registerNativeProvider(runtimeProvider)
  }
}
