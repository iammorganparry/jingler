import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import {
  CURRENT_RUNTIME_CONTRACTS,
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
  inactiveRuntimeActivity,
  type AgentRuntimeContext
} from "../agent/agent-runtime.js"
import { makePiAgentRuntime } from "../agent/pi-agent-runtime.js"
import { makePiSessionFactory } from "../agent/pi-session-factory.js"
import type { ProviderCredentialStore } from "../auth/credential-store.js"
import { FileChangeTracker } from "../file-changes/file-change-tracker.js"
import { RunJournal } from "../journal/run-journal.js"
import { createMutationObserver } from "../tools/mutation-observer.js"
import { ToolRegistry } from "../tools/tool-registry.js"
import { makeAgentResourceService } from "../resources/agent-resource-service.js"
import { detectAgentResources } from "../resources/resource-detector.js"
import { registerManagedFileTools } from "../resources/managed-file-tools.js"
import { registerMcpTools, type McpToolClientFactory } from "../tools/mcp-tools.js"
import type { RuntimeMcpServer } from "../mcp/attachment.js"

const runFile = promisify(execFile)
const ALL_ROLES = ["conversation", "plan", "plan-execution", "background"] as const
const ALL_MODES = ["ask", "accept-edits", "auto", "plan", "read-only"] as const

const promptFor = (scenarioId: string): string => {
  switch (scenarioId) {
    case "permission.denied-edit":
      return "Call workspace.edit once with path src/edit.ts. If permission is denied, stop without trying another tool."
    case "diff.create-edit-delete-rename":
      return "Call workspace.edit exactly once with path src/edit.ts, then finish."
    case "resource.cleanup":
      return "Call managed-mcp exactly once, then finish."
    case "capability.managed-resources":
      return "Call resource__managed-skill, then resource__managed-prompt, then mcp__managed__write_file. Call each exactly once, then finish."
    case "structured.question-plan":
      return "Ask the structured question Continue?, then submit a one-step plan after it is answered."
    default:
      return "Reply with OK without calling a tool."
  }
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

const fileChangeRegistry = (root: string, observations: Array<EvalObservation>): ToolRegistry => {
  const tracker = new FileChangeTracker({
    artifactDir: join(root, ".jingler/diffs"),
    sessionId: "eval-session"
  })
  const journal = new RunJournal({ file: join(root, ".jingler/run-journal.json") })
  const registry = new ToolRegistry({
    observer: createMutationObserver({
      cwd: root,
      runId: "eval-run",
      sessionId: "eval-session",
      chatId: "eval-chat",
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
  await writeFile(
    join(skillDir, "SKILL.md"),
    "name: managed-skill\ndescription: Managed skill fixture\nUse the managed skill."
  )
  await writeFile(join(promptDir, "managed-prompt.md"), "Use the managed prompt.")
  const service = await Effect.runPromise(
    makeAgentResourceService({
      managedRoot: join(root, ".jingler", "managed-resources")
    })
  )
  const detected = await Effect.runPromise(
    detectAgentResources({
      homeDir: null,
      worktreePath: root
    })
  )
  await Effect.runPromise(
    service.importResources(
      detected.candidates.filter((candidate) => candidate.kind !== "mcp"),
      { kind: "portable", allowedTargets: [] }
    )
  )
  const tracker = new FileChangeTracker({
    artifactDir: join(root, ".jingler", "managed-diffs"),
    sessionId: "eval-session"
  })
  const registry = new ToolRegistry({
    observer: createMutationObserver({
      cwd: root,
      runId: "eval-managed-run",
      sessionId: "eval-session",
      chatId: "eval-chat",
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
      listTools: () =>
        Effect.succeed({
          tools: [
            { name: "write_file", inputSchema: { type: "object", additionalProperties: false } }
          ]
        }),
      callTool: () =>
        Effect.promise(async () => {
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
  const observations: Array<EvalObservation> = [{ kind: "event", tag: event._tag }]
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

const registryFor = async (
  scenarioId: string,
  root: string,
  observations: Array<EvalObservation>
): Promise<ToolRegistry | undefined> => {
  if (scenarioId === "resource.cleanup") return resourceRegistry(observations)
  if (scenarioId === "capability.managed-resources") {
    return managedResourceRegistry(root, observations)
  }
  return scenarioId === "permission.denied-edit" || scenarioId === "diff.create-edit-delete-rename"
    ? fileChangeRegistry(root, observations)
    : undefined
}

const specFor = (input: {
  readonly scenarioId: string
  readonly root: string
  readonly connection: ProviderConnectionType
  readonly target: PiScenarioTarget
  readonly registry: ToolRegistry | undefined
}): PiRunSpec => {
  const { scenarioId, root, connection, target, registry } = input
  const modelId = Schema.decodeUnknownSync(ProviderModelId)(
    `${target.providerId}/${target.modelId}`
  )
  return {
    runId: `eval-${scenarioId}`,
    sessionId: "eval-session",
    chatId: "eval-chat",
    connectionId: connection.id,
    modelId,
    role: scenarioId === "structured.question-plan" ? "plan" : "conversation",
    mode: scenarioId === "structured.question-plan" ? "plan" : "ask",
    cwd: root,
    prompt: promptFor(scenarioId),
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
    ...inactiveRuntimeActivity,
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
        return scenarioId === "structured.question-plan"
          ? ({ _tag: "Approve", mode: "auto" } as const)
          : ({ _tag: "Reject" } as const)
      })
  }
}

const recordPreflight = (
  scenarioId: string,
  authKind: AuthKind,
  spec: PiRunSpec,
  observations: Array<EvalObservation>
): void => {
  if (scenarioId === "auth.route-pinned") {
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
  readonly connection: ProviderConnectionType
  readonly credentials: ProviderCredentialStore
  readonly registry: ToolRegistry | undefined
  readonly spec: PiRunSpec
  readonly context: AgentRuntimeContext
  readonly configureModelRuntime?: (runtime: ModelRuntime) => void | Promise<void>
}

const executeScenario = async (input: ScenarioExecution): Promise<EvalTrace> => {
  const { scenarioId, startedAt, root, observations, connection } = input
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
    ...(input.configureModelRuntime ? { configureModelRuntime: input.configureModelRuntime } : {})
  })
  const runtime = await Effect.runPromise(makePiAgentRuntime(factory))
  const events = await Effect.runPromise(Stream.runCollect(runtime.run(spec, context)))
  observations.push(...[...events].flatMap((event) => observeStreamEvent(event, registry)))
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

export interface PiScenarioTarget {
  readonly providerId: string
  readonly modelId: string
}

export interface RunPiScenarioInput {
  readonly scenarioId: string
  readonly connection: ProviderConnectionType
  readonly credentials: ProviderCredentialStore
  readonly target: PiScenarioTarget
  readonly configureModelRuntime?: (runtime: ModelRuntime) => void | Promise<void>
}

export const runPiScenario = async (input: RunPiScenarioInput): Promise<EvalTrace> => {
  const { scenarioId, connection, credentials, target } = input
  const startedAt = performance.now()
  const root = await createWorkspace()
  const observations: Array<EvalObservation> = []
  const registry = await registryFor(scenarioId, root, observations)
  const spec = specFor({ scenarioId, root, connection, target, registry })
  const context = contextFor(scenarioId, observations)

  try {
    return await executeScenario({
      scenarioId,
      startedAt,
      root,
      observations,
      connection,
      credentials,
      registry,
      spec,
      context,
      ...(input.configureModelRuntime ? { configureModelRuntime: input.configureModelRuntime } : {})
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
