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
  type ModelCertification
} from "@jingler/core"
import { Schema } from "effect"
import { type DiscoveredProviderModel } from "@jingler/cli-adapters"
import { scriptedPiScenarioResponses } from "@jingler/cli-adapters/runtime/certification/pi-scenario-fixture"
import {
  E2E_PI_PROVIDER_ID,
  e2ePiIdentity
} from "./fixture-identity.js"
import {
  E2E_BACKGROUND_TOOL,
  E2E_HELD_SUBAGENTS_TOOL,
  E2E_HOLD_TOOL,
  E2E_PLAN_PROGRESS_TOOL,
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
const SUBMIT_PLAN_TOOL = "plannotator_submit_plan"
const QUESTION_TOOL = "jingler_ask_question"
const READ_TOOL = "workspace_read_file"
const WRITE_TOOL = "workspace_write"
const RENAME_TOOL = "workspace_rename"
const COMMAND_TOOL = "command_execute"
const SUBAGENT_TOOL = "subagent"
const SUPERVISOR_REVIEW_TASK = "Review the checkout flow against its acceptance criteria."
const E2E_CONTEXT_WINDOW = 1_000_000
const observedRouteFor = (authRoute: E2ePiFixture["authRoute"]): string =>
  authRoute === "claude-setup-token"
    ? "claude-cli:subscription"
    : `e2e-${authRoute}`
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
/** Test fixtures are accepted only in an explicitly marked Electron e2e process. */
export const loadE2ePiFixture = (): E2ePiFixture | null => {
  const path = process.env.JINGLER_E2E_PI_FIXTURE
  if (process.env.JINGLER_E2E !== "1" || path === undefined) return null
  return Schema.decodeUnknownSync(E2ePiFixture)(JSON.parse(readFileSync(path, "utf8")))
}

export const e2eProviderConnection = (fixture: E2ePiFixture) => {
  const identity = e2ePiIdentity(fixture.scenarioId)
  return Schema.decodeUnknownSync(ProviderConnection)({
    id: identity.connectionId,
    providerId: identity.providerId,
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
}

const e2eDiscoveredModel = (
  fixture: E2ePiFixture,
  providerId: ProviderId,
  index: number
): DiscoveredProviderModel => ({
  providerId,
  id: Schema.decodeUnknownSync(ProviderModelId)(
    fixture.scenarioId === "named-mcp"
      ? e2ePiIdentity(fixture.scenarioId).modelId
      : `${providerId}/${index === 0 ? "eval-model" : `eval-model-${index + 1}`}`
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
  providerId: ProviderId = Schema.decodeUnknownSync(ProviderId)(
    e2ePiIdentity(fixture.scenarioId).providerId
  ),
  modelId: ProviderModelId = Schema.decodeUnknownSync(ProviderModelId)(
    e2ePiIdentity(fixture.scenarioId).modelId
  )
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

const callTool = (
  name: string,
  input: Parameters<typeof fauxToolCall>[1],
  id: string
): ReturnType<typeof fauxAssistantMessage> =>
  fauxAssistantMessage(fauxToolCall(name, input, { id }), {
    stopReason: "toolUse"
  })

const browserUrlFrom = (context: PiContext): string => {
  const match = latestOperatorText(context).match(/\[\[browser-url=([^\]]+)\]\]/)
  return match?.[1] ?? "about:blank"
}

const backgroundKindFrom = (context: PiContext): E2eBackgroundKind | null => {
  const prompt = latestOperatorText(context)
  if (prompt.includes("[[legacy-agent]]")) return "legacy-agent"
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
      : kind === "legacy-agent"
        ? "Delegated through the normalized compatibility path."
        : "Started a watcher in the background."
  )
}

const heldSubagentsResponse = (
  context: PiContext
): ReturnType<typeof fauxAssistantMessage> | null => {
  const prompts = operatorText(context)
  const direct = prompts.some((prompt) => prompt.includes("[[direct-subagent]]"))
  if (!direct && !prompts.some((prompt) => prompt.includes("[[held-subagents]]"))) return null

  const marker = direct ? "[[direct-subagent]]" : "[[held-subagents]]"
  const prompt = latestOperatorText(context)
  const steered = !prompt.includes(marker)
  const resultsAfterLatestPrompt = recentToolResultCount(context, E2E_HELD_SUBAGENTS_TOOL)
  const startPhase = direct ? "direct-start" : "start"
  if (!steered) {
    const toolCall = fauxToolCall(
      E2E_HELD_SUBAGENTS_TOOL,
      {
        phase: resultsAfterLatestPrompt === 0
          ? startPhase
          : "wait"
      },
      { id: `${direct ? "direct-subagent" : "held-subagents"}-${resultsAfterLatestPrompt}` }
    )
    return fauxAssistantMessage(
      resultsAfterLatestPrompt === 0
        ? [fauxText(direct ? "Delegated to one direct child." : "Delegated to two agents."), toolCall]
        : toolCall,
      { stopReason: "toolUse" }
    )
  }
  return steeredSubagentResponse(context, resultsAfterLatestPrompt, direct)
}

const supervisorSubagentResponse = (
  context: PiContext
): ReturnType<typeof fauxAssistantMessage> | null => {
  const prompts = operatorText(context)
  if (!prompts.some((text) => text.includes("[[supervisor-subagent]]"))) return null
  if (prompts.some((text) =>
    text.includes("Should I include accessibility behavior in this review?")
  )) {
    return fauxAssistantMessage("Reviewer is waiting for supervisor input.")
  }
  if (recentToolResultCount(context, SUBAGENT_TOOL) === 0) {
    return callTool(
      SUBAGENT_TOOL,
      { agent: "reviewer", task: SUPERVISOR_REVIEW_TASK },
      "supervisor-reviewer"
    )
  }
  return fauxAssistantMessage("Reviewer detached promptly and is waiting for supervisor input.")
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
  return stabilityFileResponse(prompt, writes) ?? followedFileResponse(context, prompt, writes)
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
    return fauxAssistantMessage(fauxToolCall(E2E_REVIEW_PAUSE_TOOL, {
      hold: operatorText(context).some((text) => text.includes("[[review-switch-stress]]"))
    }), {
      stopReason: "toolUse"
    })
  }
  return fauxAssistantMessage('```json\n{"findings":[]}\n```')
}

const PLANNOTATOR_E2E_PLAN = [
  "# Context",
  "Replace the auth flow with a deterministic test implementation.",
  "",
  "# Steps",
  "- [ ] Implement the auth change",
  "- [ ] Verify the auth change",
  "",
  "# Verification",
  "Run the focused auth checks."
].join("\n")

const STRUCTURED_REVIEW_PLAN = [
  "# Auth replacement",
  "",
  "## Context",
  "Replace the auth flow with a deterministic test implementation.",
  "",
  "```mermaid",
  "flowchart LR",
  "  implement[Implement auth] --> verify[Verify auth]",
  "```",
  "",
  "## Implement auth <!-- id: implement-auth -->",
  "Implement the auth change.",
  "### Deliverable",
  "Auth tokens use the new format through the existing entry point.",
  "### User story",
  "**As a** returning user",
  "**I want** authentication to use the updated token format",
  "**So that** my session remains valid through the migration",
  "### Approach",
  "- Replace the token format",
  "### Technical explanation",
  "The implementation replaces the token format at the existing auth entry point.",
  "```diff path=src/auth.ts",
  "@@ -1 +1 @@",
  "-export const tokenFormat = \"v1\"",
  "+export const tokenFormat = \"v2\"",
  "```",
  "```mermaid",
  "flowchart LR",
  "  implement[Implement auth] --> verify[Verify auth]",
  "  %% link verify stage:verify-auth",
  "  %% link implement file:README.md",
  "```",
  "### Tasks",
  "- [ ] Implement the auth change",
  "### Acceptance",
  "- [ ] Auth implementation passes (test[unit]: src/auth.test.ts::implements auth)",
  "### Definition of Done",
  "- Acceptance criteria verified",
  "- Focused tests and typecheck pass",
  "### Files",
  "- `src/auth.ts` — M",
  "> complexity: low",
  "",
  "## Verify auth <!-- id: verify-auth -->",
  "Verify the auth change.",
  "### Deliverable",
  "Focused checks prove the token migration is safe.",
  "### User story",
  "**As a** maintainer",
  "**I want** focused verification for the token migration",
  "**So that** regressions are caught before release",
  "### Approach",
  "- Run focused auth checks",
  "### Technical explanation",
  "Verification checks the existing auth entry point without changing its callers.",
  "```diff path=README.md",
  "@@ -1 +1,2 @@",
  " # e2e repo",
  "+Auth checks live in src/auth.test.ts.",
  "```",
  "### Tasks",
  "- [ ] Verify the auth change",
  "### Acceptance",
  "- [ ] Auth verification passes (test: src/auth.test.ts::verifies auth)",
  "### Definition of Done",
  "- Acceptance criteria verified",
  "- Focused tests and typecheck pass",
  "### Files",
  "- `src/auth.test.ts` — M",
  "> complexity: low",
  "> depends: implement-auth",
  "",
  "## Test strategy",
  "Unit tests cover the token format; the e2e flow covers sign-in.",
  "",
  "## Verification",
  "Run the focused auth checks."
].join("\n")

// Breaks both hard submit rules: an escaping diff path and no Test strategy.
const INVALID_REVIEW_PLAN = STRUCTURED_REVIEW_PLAN
  .replace("```diff path=src/auth.ts", "```diff path=../outside.ts")
  .replace("## Test strategy\nUnit tests cover the token format; the e2e flow covers sign-in.\n\n", "")

const PLAN_ANCHOR = "Replace the auth flow with a deterministic test implementation."
/** The review plan with one prefixed note per line appended under its anchor. */
const planWithNotes = (prefix: string, lines: ReadonlyArray<string>): string =>
  STRUCTURED_REVIEW_PLAN.replace(PLAN_ANCHOR, [PLAN_ANCHOR, ...lines.map((line) => `${prefix}${line}`)].join("\n"))

const SubmitVerdict = Schema.parseJson(Schema.Struct({ approved: Schema.Boolean, feedback: Schema.optional(Schema.String) }))
const INVALID_PLAN_PREFIX = "invalid-input: "

const planExecutionResponse = (context: PiContext): ReturnType<typeof fauxAssistantMessage> => {
  if (recentToolResultCount(context, E2E_PLAN_PROGRESS_TOOL) === 0) {
    return fauxAssistantMessage([
      fauxText("Implemented the first plan step. [DONE:1] [DONE:2]"),
      fauxToolCall(E2E_PLAN_PROGRESS_TOOL, {}, { id: "plannotator-progress" })
    ], { stopReason: "toolUse" })
  }
  return fauxAssistantMessage("Implemented and verified the approved plan. [DONE:3] [DONE:4]")
}

/** The agent's reply to a submit_plan result: fix, revise, or execute. */
const submitResultResponse = (context: PiContext, result: string, submitCount: number): ReturnType<typeof fauxAssistantMessage> => {
  if (result.startsWith(INVALID_PLAN_PREFIX)) {
    // Echo the validator's own errors so e2e proves the real submit gate ran.
    const errors = result.slice(INVALID_PLAN_PREFIX.length).split("\n")
    return callTool(WRITE_TOOL, { path: "PLAN.md", content: planWithNotes("Fixed validation error: ", errors) }, `plannotator-fix-${submitCount}`)
  }
  const verdict = Schema.decodeUnknownSync(SubmitVerdict)(result)
  if (verdict.approved) return planExecutionResponse(context)
  // Echo each quoted anchor from the reviewer's feedback into the plan, so
  // e2e can prove selection comments reached the agent verbatim.
  const quoted = (verdict.feedback ?? "").split("\n").filter((line) => line.startsWith("> ")).map((line) => line.slice(2))
  return callTool(
    WRITE_TOOL,
    {
      path: "PLAN.md",
      content: planWithNotes("Reviewer quoted: ", quoted).replace(
        "- Replace the token format",
        "- Revise auth while keeping the existing token format"
      ).replace(
        "The implementation replaces the token format at the existing auth entry point.",
        "The implementation preserves compatibility by keeping the existing token format."
      )
    },
    `plannotator-rewrite-${submitCount}`
  )
}

const planModeResponse = (context: PiContext): ReturnType<typeof fauxAssistantMessage> => {
  const lastMessage = context.messages.at(-1)
  const planMessages = operatorText(context)
  const planStart = planMessages.findLastIndex((text) => text.includes("[[plan]]"))
  const currentPlanMessages = planStart < 0 ? planMessages : planMessages.slice(planStart)
  // Restart recovery delivers the verdict before starting the harness; live
  // review returns it through the shared tool in the same model loop.
  if (currentPlanMessages.some((text) => text.includes("Plan approved.")) ||
    (lastMessage?.role === "toolResult" && lastMessage.toolName === E2E_PLAN_PROGRESS_TOOL)) {
    return planExecutionResponse(context)
  }
  const submitCount = context.messages.filter(
    (message) => message.role === "toolResult" && message.toolName === SUBMIT_PLAN_TOOL
  ).length
  if (lastMessage?.role === "toolResult" && lastMessage.toolName === SUBMIT_PLAN_TOOL) {
    return submitResultResponse(context, toolResultText(lastMessage), submitCount)
  }
  if (lastMessage?.role === "toolResult" && lastMessage.toolName === WRITE_TOOL) {
    return callTool(SUBMIT_PLAN_TOOL, { filePath: "PLAN.md" }, `plannotator-submit-${submitCount + 1}`)
  }
  const invalid = currentPlanMessages.some((text) => text.includes("[[invalid-plan]]"))
  return callTool(WRITE_TOOL, { path: "PLAN.md", content: invalid ? INVALID_REVIEW_PLAN : STRUCTURED_REVIEW_PLAN }, "plannotator-write")
}

const UPDATE_PLAN_TOOL = "plannotator_update_plan"

// Exercises the always-available plan scratchpad OUTSIDE plan mode: the model
// writes a plan file, adopts it silently with plannotator_update_plan, then
// ticks the first step with a [DONE:1] marker — no review, no phase change.
const planScratchpadResponse = (context: PiContext): ReturnType<typeof fauxAssistantMessage> => {
  const lastMessage = context.messages.at(-1)
  if (lastMessage?.role === "toolResult" && lastMessage.toolName === UPDATE_PLAN_TOOL) {
    return fauxAssistantMessage(
      "Adopted the plan scratchpad and finished the first step. [DONE:1]"
    )
  }
  if (lastMessage?.role === "toolResult" && lastMessage.toolName === WRITE_TOOL) {
    return callTool(UPDATE_PLAN_TOOL, { filePath: "PLAN.md" }, "plannotator-update")
  }
  // Normal sessions carry Jingler's workspace tools, not pi's plan-mode
  // write/edit pair — the scratchpad flow must work with the ordinary toolset.
  return callTool(
    WRITE_TOOL,
    { path: "PLAN.md", content: PLANNOTATOR_E2E_PLAN },
    "plannotator-scratchpad-write"
  )
}

const RICH_SCRATCHPAD_PLAN = [
  "---",
  "title: Token store rollout",
  "revision: 1",
  "---",
  "Replace scattered auth reads with one TokenStore.",
  "",
  "## Token store <!-- id: stage-store -->",
  "Build the store behind the existing interface.",
  "",
  "### Approach",
  "- Add the module",
  "- Keep the old reads until rollout",
  "",
  "- [ ] Implement TokenStore",
  "- [ ] Wire the callers",
  "",
  "### Acceptance",
  "- [ ] Store tests green (test: src/store.test.ts::caches tokens)",
  "",
  "### Files",
  "- `src/store.ts` — A",
  "",
  "> complexity: medium",
  "",
  "## Rollout <!-- id: stage-rollout -->",
  "Switch callers over once the store holds.",
  "",
  "- [ ] Flip the flag"
].join("\n")

// The rich scratchpad convention outside plan mode: a structured multi-stage
// plan adopted silently, then progress ticked with [DONE:1].
const richScratchpadResponse = (context: PiContext): ReturnType<typeof fauxAssistantMessage> => {
  const lastMessage = context.messages.at(-1)
  if (lastMessage?.role === "toolResult" && lastMessage.toolName === UPDATE_PLAN_TOOL) {
    return fauxAssistantMessage(
      "Adopted the structured plan. TokenStore implemented. [DONE:1]"
    )
  }
  if (lastMessage?.role === "toolResult" && lastMessage.toolName === WRITE_TOOL) {
    return callTool(UPDATE_PLAN_TOOL, { filePath: "PLAN.md" }, "plannotator-rich-update")
  }
  return callTool(
    WRITE_TOOL,
    { path: "PLAN.md", content: RICH_SCRATCHPAD_PLAN },
    "plannotator-rich-write"
  )
}

const defaultResponse = (context: PiContext): ReturnType<typeof fauxAssistantMessage> => {
  const prompt = latestOperatorText(context)
  if (prompt.includes("[[complete-session]]")) {
    const lastMessage = context.messages.at(-1)
    return lastMessage?.role === "toolResult" && lastMessage.toolName === "jingler_complete_session"
      ? fauxAssistantMessage("All requested work is complete.")
      : callTool("jingler_complete_session", {}, "complete-session")
  }
  if (prompt.includes("[[beui-production]]")) {
    return fauxAssistantMessage([
      "Production renderers are mounted.",
      "```typescript",
      "const production = true",
      "```",
      "```diff",
      "diff --git a/src/production.ts b/src/production.ts",
      "--- a/src/production.ts",
      "+++ b/src/production.ts",
      "@@ -1 +1 @@",
      "-false",
      "+true",
      "```"
    ].join("\n"))
  }
  if (prompt.includes("[[expect-code-context]]")) {
    return fauxAssistantMessage(
      prompt.includes("<repository-code-references>")
        ? "Received selected diff context."
        : "Selected diff context was missing."
    )
  }
  return scenarioFixtureResponse(context)
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

const routineProofResponse = async (context: PiContext): Promise<ReturnType<typeof fauxAssistantMessage>> => {
  const prompt = latestOperatorText(context)
  if (!prompt.includes("routine proof")) return defaultResponse(context)
  const write = prompt.includes("WRITE")
  const tool = write ? WRITE_TOOL : READ_TOOL
  if (recentToolResultCount(context, tool) === 0) {
    return callTool(tool, write ? { path: "routine-proof.txt", content: "unsafe" } : { path: "README.md" }, "routine-inspect")
  }
  await new Promise((resolve) => setTimeout(resolve, 10000))
  return fauxAssistantMessage("Routine proof inspection complete.")
}

const responsesFor = (fixture: E2ePiFixture): ReadonlyArray<FauxResponseStep> => {
  switch (fixture.scenarioId) {
    case "send-progress":
      // The real title role waits on the scripted transport, so creation stays
      // pending after the workspace exists. No provider/network request occurs.
      return Array.from({ length: 16 }, () => async () => {
        await new Promise(resolve => setTimeout(resolve, 5000))
        return fauxAssistantMessage(JSON.stringify({ title: "Delayed naming proof", branch: { type: "chore", slug: "delayed-naming-proof" } }))
      })
    case "workspace-workflow":
      return Array.from({ length: 32 }, () => () => fauxAssistantMessage("Workflow turn admitted."))
    case "workspace-safe-refusals":
      return Array.from({ length: 32 }, () => (context: PiContext) => {
        if (recentToolResultCount(context, RENAME_TOOL) === 0) {
          return callTool(RENAME_TOOL, { from: "rename-source.txt", to: "rename-destination.txt" }, "safe-rename-refusal")
        }
        if (recentToolResultCount(context, COMMAND_TOOL) === 0) {
          return callTool(COMMAND_TOOL, { command: "node -e \"require('node:fs').writeFileSync('shell-sentinel.txt','changed')\"" }, "safe-shell-refusal")
        }
        const diagnostics = context.messages.filter(message => message.role === "toolResult").map(message => toolResultText(message)).join("\n")
        return fauxAssistantMessage(`Safe refusal diagnostics: ${diagnostics}`)
      })
    case "workspace-routines":
      return Array.from({ length: 64 }, () => routineProofResponse)
    case "workspace-checkpoints":
      return Array.from({ length: 12 }, () => async (context: PiContext) => {
        if (!latestOperatorText(context).includes("checkpoint")) return defaultResponse(context)
        if (recentToolResultCount(context, WRITE_TOOL) === 0) {
          return callTool(WRITE_TOOL, { path: "checkpoint-proof.txt", content: "changed" }, "checkpoint-write")
        }
        await new Promise((resolve) => setTimeout(resolve, 10000))
        return fauxAssistantMessage("Checkpoint edit complete.")
      })
    case "plan-mode":
      return Array.from({ length: 12 }, () => planModeResponse)
    case "plan-scratchpad":
      return Array.from({ length: 8 }, () => planScratchpadResponse)
    case "rich-plan-scratchpad":
      return Array.from({ length: 8 }, () => richScratchpadResponse)
    case "managed-resources":
      return [
        fauxAssistantMessage(fauxToolCall("jingler_load_resource", { id: "managed-skill" }), {
          stopReason: "toolUse"
        }),
        fauxAssistantMessage("Managed skill loaded through pi.")
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

const withE2eSubscriptionAuth = (
  provider: Provider,
  authKind: E2ePiFixture["authRoute"]
): Provider =>
  authKind === "claude-setup-token" || authKind === "openai-codex-oauth"
    ? {
        ...provider,
        auth: {
          ...provider.auth,
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
    : provider

export const configureE2ePiProvider = (fixture: E2ePiFixture) => {
  if (fixture.scenarioId === "named-mcp") return (_runtime: ModelRuntime): void => undefined
  const tokenSize =
    fixture.scenarioId === "plan-mode" || fixture.scenarioId === "context-compaction"
      ? { min: 4_096, max: 4_096 }
      : null
  const provider = fauxProvider({
    provider: PROVIDER_ID,
    api: "jingler-e2e-api",
    models: [{ id: "eval-model", contextWindow: E2E_CONTEXT_WINDOW }],
    tokensPerSecond: fixture.scenarioId === "follow-stability" ? 60 : 0,
    ...(tokenSize === null ? {} : { tokenSize })
  })
  provider.setResponses([...responsesFor(fixture)])
  return (runtime: ModelRuntime): void => {
    runtime.registerNativeProvider(withE2eSubscriptionAuth(
      provider.provider,
      fixture.authRoute
    ))
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
  return (runtime: ModelRuntime): void => {
    runtime.registerNativeProvider(withE2eSubscriptionAuth(
      provider.provider,
      authKind
    ))
  }
}

function offloadFixtureResponse(context: PiContext) {
  if (latestOperatorText(context).includes("[[offload-local-retry]]")) {
    return recentToolResultCount(context, COMMAND_TOOL) === 0
      ? callTool(
        COMMAND_TOOL,
        { command: "pnpm typecheck" },
        "offload-local-retry-1"
      )
      : fauxAssistantMessage("Explicit local retry completed.")
  }
  if (latestOperatorText(context).includes("[[offload-owned-device-offline]]")) {
    return recentToolResultCount(context, COMMAND_TOOL) === 0
      ? callTool(
        COMMAND_TOOL,
        { command: "node -e \"process.stdout.write('offline command must not run\\\\n')\"" },
        "offload-owned-device-offline-1"
      )
      : fauxAssistantMessage("Offline owned-device attempt completed.")
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

function scenarioFixtureResponse(context: PiContext) {
  const fileBrowser = fileBrowserResponse(context)
  if (fileBrowser !== null) return fileBrowser
  const supervisorSubagent = supervisorSubagentResponse(context)
  if (supervisorSubagent !== null) return supervisorSubagent
  const heldSubagents = heldSubagentsResponse(context)
  if (heldSubagents !== null) return heldSubagents
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
  return offloadFixtureResponse(context)
}

function stabilityFileResponse(prompt: string, writes: number) {
  const operation = /\[\[follow-stability\]\] (first|second|other)/u.exec(prompt)?.[1]
  if (operation === undefined) return null
  if (writes > 0) return fauxAssistantMessage(fauxText([
    `${operation}: Settled file operation. `,
    `${operation}: Still streaming the same completed operation. `.repeat(60),
    `${operation}: Stability stream finished.`
  ].join("")))
  return callTool(WRITE_TOOL, {
    path: operation === "other" ? "src/other.ts" : "src/config.ts",
    content: operation === "other" ? "export const other = 'changed'\n"
      : operation === "second" ? "export const mode = 'second'\n" : MODERN_CONFIG
  }, `stability-${operation}`)
}

function followedFileResponse(context: PiContext, prompt: string, writes: number) {
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

function steeredSubagentResponse(context: PiContext, resultsAfterLatestPrompt: number, direct: boolean) {
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
      { phase: direct ? "direct-settle" : "settle" },
      "held-steer-settle"
    )
  }
  return fauxAssistantMessage(direct ? "Direct child reported back." : "Both agents reported back.")
}
