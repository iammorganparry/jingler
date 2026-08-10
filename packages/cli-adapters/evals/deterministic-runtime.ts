import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  CURRENT_RUNTIME_CONTRACTS,
  defaultPlan,
  ProviderConnection,
  ProviderModelId,
  runtimeCapabilitiesMatch,
  type AuthKind,
  type PiRunSpec,
  type ProviderConnection as ProviderConnectionType,
  type StreamEvent
} from "@jingler/core"
import { Effect, Schema, Stream } from "effect"
import type { EvalObservation, EvalTrace } from "./behavior-contract.js"
import {
  FakePiProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FakePiResponse
} from "./fixtures/fake-pi-provider.js"
import type { AgentRuntimeContext } from "../src/runtime/agent/agent-runtime.js"
import { makePiAgentRuntime } from "../src/runtime/agent/pi-agent-runtime.js"
import { makePiSessionFactory } from "../src/runtime/agent/pi-session-factory.js"
import { InMemoryProviderCredentialStore } from "../src/runtime/auth/credential-store.js"
import { FileChangeTracker } from "../src/runtime/file-changes/file-change-tracker.js"
import { RunJournal } from "../src/runtime/journal/run-journal.js"
import { createMutationObserver } from "../src/runtime/tools/mutation-observer.js"
import { ToolRegistry } from "../src/runtime/tools/tool-registry.js"
import { makeAgentResourceService } from "../src/runtime/resources/agent-resource-service.js"
import { detectAgentResources } from "../src/runtime/resources/resource-detector.js"
import { registerManagedFileTools } from "../src/runtime/resources/managed-file-tools.js"
import {
  registerMcpTools,
  type McpToolClientFactory
} from "../src/runtime/tools/mcp-tools.js"
import type { RuntimeMcpServer } from "../src/runtime/mcp/attachment.js"

const runFile = promisify(execFile)
const ALL_ROLES = ["conversation", "plan", "plan-execution", "background"] as const
const ALL_MODES = ["ask", "accept-edits", "auto", "plan", "read-only"] as const

const authKindFor = (scenarioId: string): AuthKind =>
  scenarioId === "auth.codex-subscription-pinned"
    ? "openai-codex-oauth"
    : scenarioId === "auth.claude-subscription-pinned"
      ? "claude-setup-token"
      : "api-key"

const responsesFor = (scenarioId: string): ReadonlyArray<FakePiResponse> => {
  if (scenarioId === "permission.denied-edit" || scenarioId === "diff.create-edit-delete-rename") {
    return [
      fauxAssistantMessage(
        fauxToolCall("workspace.edit", { path: "src/edit.ts" }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("complete")
    ]
  }
  if (scenarioId === "resource.cleanup") {
    return [
      fauxAssistantMessage(fauxToolCall("managed-mcp", {}), {
        stopReason: "toolUse"
      }),
      fauxAssistantMessage("complete")
    ]
  }
  if (scenarioId === "capability.managed-resources") {
    return [
      fauxAssistantMessage(fauxToolCall("resource__managed-skill", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("resource__managed-prompt", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("mcp__managed__write_file", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("complete")
    ]
  }
  if (scenarioId === "structured.question-plan") {
    return [
      fauxAssistantMessage(
        fauxToolCall("jingler_ask_question", {
          id: "eval-question",
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              multiSelect: false,
              options: [
                { label: "Yes", description: "Continue the scenario." },
                { label: "No", description: "Stop the scenario." }
              ]
            }
          ]
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        fauxToolCall("jingler_submit_plan", {
          plan: defaultPlan("Verify deterministic structured interaction.")
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("complete")
    ]
  }
  return [fauxAssistantMessage("complete")]
}

const createWorkspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "jingler-pi-eval-"))
  await runFile("git", ["init", "--quiet", root])
  await mkdir(join(root, "src"), { recursive: true })
  await Promise.all([
    writeFile(join(root, "src/edit.ts"), "export const edited = false\n"),
    writeFile(join(root, "src/delete.ts"), "export const removed = true\n"),
    writeFile(join(root, "src/old.ts"), "export const renamed = true\n")
  ])
  return root
}

const fileChangeRegistry = (
  root: string,
  observations: Array<EvalObservation>
): ToolRegistry => {
  const tracker = new FileChangeTracker({
    artifactDir: join(root, ".jingler/diffs"),
    sessionId: "eval-session"
  })
  const journal = new RunJournal({ file: join(root, ".jingler/run-journal.json") })
  const registry = new ToolRegistry({
    observer: createMutationObserver({
      cwd: root,
      runId: "eval-run",
      tracker,
      journal
    })
  })
  registry.register({
    id: "workspace.edit",
    version: "1",
    description: "Apply the deterministic file-change fixture.",
    input: Schema.Struct({ path: Schema.String }),
    risk: "mutate",
    roles: ALL_ROLES,
    modes: ALL_MODES,
    timeoutMs: 5_000,
    outputBudget: 1_000,
    cancellable: true,
    idempotency: "keyed",
    execute: async () => {
      observations.push({ kind: "tool-effect", tool: "workspace.edit" })
      await Promise.all([
        writeFile(join(root, "src/new.ts"), "export const created = true\n"),
        writeFile(join(root, "src/edit.ts"), "export const edited = true\n"),
        rm(join(root, "src/delete.ts")),
        rename(join(root, "src/old.ts"), join(root, "src/renamed.ts"))
      ])
      return { changed: true }
    }
  })
  return registry
}

const resourceRegistry = (observations: Array<EvalObservation>): ToolRegistry => {
  const registry = new ToolRegistry()
  registry.register({
    id: "managed-mcp",
    version: "1",
    description: "Open and close the deterministic managed resource.",
    input: Schema.Struct({}),
    risk: "read",
    roles: ALL_ROLES,
    modes: ALL_MODES,
    timeoutMs: 5_000,
    outputBudget: 1_000,
    cancellable: true,
    idempotency: "safe",
    execute: async () => {
      observations.push(
        { kind: "resource", name: "managed-mcp", state: "opened" },
        { kind: "resource", name: "managed-mcp", state: "closed" }
      )
      return { closed: true }
    }
  })
  return registry
}

const managedResourceRegistry = async (
  root: string,
  observations: Array<EvalObservation>
): Promise<ToolRegistry> => {
  const skillDir = join(root, ".agents", "skills", "managed-skill")
  const promptDir = join(root, ".pi", "agent", "prompts")
  await mkdir(skillDir, { recursive: true })
  await mkdir(promptDir, { recursive: true })
  await writeFile(join(skillDir, "SKILL.md"), "name: managed-skill\ndescription: Managed skill fixture\nUse the managed skill.")
  await writeFile(join(promptDir, "managed-prompt.md"), "Use the managed prompt.")
  const service = await Effect.runPromise(makeAgentResourceService({
    managedRoot: join(root, ".jingler", "managed-resources")
  }))
  const detected = await Effect.runPromise(detectAgentResources({
    homeDir: null,
    worktreePath: root
  }))
  await Effect.runPromise(service.importResources(
    detected.candidates.filter((candidate) => candidate.kind !== "mcp"),
    { kind: "portable", allowedTargets: [] }
  ))
  const tracker = new FileChangeTracker({
    artifactDir: join(root, ".jingler", "managed-diffs"),
    sessionId: "eval-session"
  })
  const registry = new ToolRegistry({
    observer: createMutationObserver({
      cwd: root,
      runId: "eval-managed-run",
      tracker,
      journal: new RunJournal({ file: join(root, ".jingler", "managed-run.json") })
    })
  })
  registerManagedFileTools(
    registry,
    service,
    await Effect.runPromise(service.enabledForTarget("desktop"))
  )
  const server: RuntimeMcpServer = {
    name: "managed",
    url: "https://managed.invalid/mcp",
    headers: {}
  }
  const factory: McpToolClientFactory = () => {
    observations.push({ kind: "resource", name: "managed-mcp", state: "opened" })
    return Effect.succeed({
      listTools: () => Effect.succeed({
        tools: [{ name: "write_file", inputSchema: { type: "object", additionalProperties: false } }]
      }),
      callTool: () => Effect.promise(async () => {
        observations.push({ kind: "tool-effect", tool: "mcp__managed__write_file" })
        await writeFile(join(root, "src", "mcp-created.ts"), "export const managed = true\n")
        return { content: [{ type: "text", text: "created" }] }
      }),
      close: Effect.sync(() => {
        observations.push({ kind: "resource", name: "managed-mcp", state: "closed" })
      })
    })
  }
  await Effect.runPromise(registerMcpTools(registry, [{ server, risk: "execute" }], factory))
  return registry
}

const observeStreamEvent = (
  event: StreamEvent,
  registry: ToolRegistry | undefined
): ReadonlyArray<EvalObservation> => {
  const observations: Array<EvalObservation> = [
    { kind: "event", tag: event._tag }
  ]
  if (event._tag === "Failed") {
    observations.push({ kind: "report-text", text: event.message })
  }
  if (event._tag === "ToolStart") {
    observations.push({
      kind: "tool-call",
      tool: event.name,
      risk: registry?.riskFor(event.name) ?? "read"
    })
  }
  if (event._tag === "ToolEnd" && event.fileChanges) {
    observations.push(
      ...event.fileChanges.changes.map((change) => ({
        kind: "file-change" as const,
        status: change.status,
        path: change.path,
        oldPath: change.oldPath
      }))
    )
  }
  return observations
}

const connectionFor = (
  fake: FakePiProvider,
  authKind: AuthKind
): ProviderConnectionType =>
  Schema.decodeUnknownSync(ProviderConnection)({
    id: `eval-${authKind}`,
    providerId: fake.providerId,
    authKind,
    account: { fingerprint: "eval-account", displayLabel: "Deterministic" },
    targetId: "desktop",
    status: "authenticated",
    subscription: {
      entitlement: "active",
      planLabel: "Deterministic",
      expiresAt: null,
      quotaLabel: null,
      rateLimitLabel: null,
      confirmedBillingRoute:
        authKind === "api-key" ? "api" : "subscription"
    },
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z"
  })

const credentialsFor = async (
  connection: ProviderConnectionType,
  authKind: AuthKind
): Promise<InMemoryProviderCredentialStore> => {
  const credentials = new InMemoryProviderCredentialStore()
  await Effect.runPromise(
    credentials.write({
      connectionId: connection.id,
      authKind,
      access: "deterministic-credential",
      refresh: authKind === "openai-codex-oauth" ? "deterministic-refresh" : null,
      expiresAt:
        authKind === "openai-codex-oauth" ? Date.now() + 60 * 60_000 : null
    })
  )
  return credentials
}

const registryFor = async (
  scenarioId: string,
  root: string,
  observations: Array<EvalObservation>
): Promise<ToolRegistry | undefined> => {
  if (scenarioId === "resource.cleanup") return resourceRegistry(observations)
  if (scenarioId === "capability.managed-resources") {
    return managedResourceRegistry(root, observations)
  }
  return scenarioId === "permission.denied-edit" ||
    scenarioId === "diff.create-edit-delete-rename"
    ? fileChangeRegistry(root, observations)
    : undefined
}

const specFor = (input: {
  readonly scenarioId: string
  readonly root: string
  readonly connection: ProviderConnectionType
  readonly fake: FakePiProvider
  readonly registry: ToolRegistry | undefined
}): PiRunSpec => {
  const { scenarioId, root, connection, fake, registry } = input
  const modelId = Schema.decodeUnknownSync(ProviderModelId)(
    `${fake.providerId}/${fake.modelId}`
  )
  return {
    connectionId: connection.id,
    modelId,
    role: scenarioId === "structured.question-plan" ? "plan" : "conversation",
    mode: scenarioId === "structured.question-plan" ? "plan" : "ask",
    cwd: root,
    prompt: `Run deterministic scenario ${scenarioId}`,
    priorMessages: [],
    piSessionId: null,
    seed: null,
    targetCapabilities: {
      versions: CURRENT_RUNTIME_CONTRACTS,
      toolIds: registry?.capabilitiesFor("conversation", "ask").map((tool) => tool.id) ?? [],
      resourceIds: [],
      targetId: "desktop"
    }
  }
}

const contextFor = (
  scenarioId: string,
  observations: Array<EvalObservation>
): AgentRuntimeContext => {
  const permissionDecision = scenarioId === "permission.denied-edit" ? "deny" : "allow"
  return {
    canUseTool: (request) =>
      Effect.sync(() => {
        observations.push({
          kind: "permission",
          tool: request.toolId,
          decision: permissionDecision
        })
        return permissionDecision
      }),
    askQuestion: () =>
      Effect.sync(() => {
        observations.push({ kind: "event", tag: "QuestionRequested" })
        return [{ selected: ["Yes"], other: null }]
      }),
    saveDraftPlan: () => Effect.void,
    proposePlan: () =>
      Effect.sync(() => {
        observations.push({ kind: "event", tag: "PlanProposed" })
        return { _tag: "Reject" } as const
      })
  }
}

const recordPreflight = (
  scenarioId: string,
  authKind: AuthKind,
  spec: PiRunSpec,
  observations: Array<EvalObservation>
): void => {
  if (scenarioId.startsWith("auth.")) {
    observations.push({ kind: "auth-route", route: authKind })
  }
  if (scenarioId !== "remote.contract-compatible") return
  if (!runtimeCapabilitiesMatch(spec.targetCapabilities, spec.targetCapabilities)) {
    throw new Error("deterministic target contract did not match itself")
  }
  observations.push({ kind: "event", tag: "RemoteContractAccepted" })
}

interface ScenarioExecution {
  readonly scenarioId: string
  readonly startedAt: number
  readonly root: string
  readonly observations: Array<EvalObservation>
  readonly fake: FakePiProvider
  readonly connection: ProviderConnectionType
  readonly credentials: InMemoryProviderCredentialStore
  readonly registry: ToolRegistry | undefined
  readonly spec: PiRunSpec
  readonly context: AgentRuntimeContext
}

const executeScenario = async (input: ScenarioExecution): Promise<EvalTrace> => {
  const { scenarioId, startedAt, root, observations, fake, connection } = input
  const { credentials, registry, spec, context } = input
  recordPreflight(scenarioId, connection.authKind, spec, observations)
  const tracker = registry?.hasMutatingTools(spec.role, spec.mode)
    ? new FileChangeTracker({
        artifactDir: join(root, ".jingler/terminal-diffs"),
        sessionId: "eval-session"
      })
    : undefined
  const factory = makePiSessionFactory({
    agentDir: join(root, ".jingler/agent"),
    sessionsDir: join(root, ".jingler/sessions"),
    credentials,
    resolveConnection: () => Effect.succeed(connection),
    ...(registry ? { toolRegistry: registry } : {}),
    ...(tracker ? { terminalTracker: tracker } : {}),
    configureModelRuntime: (runtime) => fake.install(runtime)
  })
  const runtime = await Effect.runPromise(makePiAgentRuntime(factory))
  const events = await Effect.runPromise(Stream.runCollect(runtime.run(spec, context)))
  observations.push(
    ...[...events].flatMap((event) => observeStreamEvent(event, registry))
  )
  const usage = [...events].find((event) => event._tag === "Done")
  return {
    scenarioId,
    observations,
    durationMs: Math.max(1, Math.ceil(performance.now() - startedAt)),
    tokens: usage?._tag === "Done" ? usage.tokens : 0,
    costUsd: usage?._tag === "Done" ? usage.costUsd : 0,
    versions: CURRENT_RUNTIME_CONTRACTS
  }
}

export const runDeterministicScenario = async (
  scenarioId: string
): Promise<EvalTrace> => {
  const startedAt = performance.now()
  const root = await createWorkspace()
  const observations: Array<EvalObservation> = []
  const authKind = authKindFor(scenarioId)
  const fake = new FakePiProvider({ oauth: authKind === "openai-codex-oauth" })
  fake.setResponses(responsesFor(scenarioId))
  const connection = connectionFor(fake, authKind)
  const credentials = await credentialsFor(connection, authKind)
  const registry = await registryFor(scenarioId, root, observations)
  const spec = specFor({ scenarioId, root, connection, fake, registry })
  const context = contextFor(scenarioId, observations)

  try {
    return await executeScenario({
      scenarioId,
      startedAt,
      root,
      observations,
      fake,
      connection,
      credentials,
      registry,
      spec,
      context
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
