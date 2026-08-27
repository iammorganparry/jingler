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
  type RuntimeCapabilityManifest,
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
import { registerCodeIntelligenceTools } from "../tools/code-intelligence-tools.js"
import { registerStructuralCodeTools } from "../tools/structural-code-tools.js"
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
      return "Call workspace_edit once with path src/edit.ts. If permission is denied, stop without trying another tool."
    case "diff.create-edit-delete-rename":
      return "Call workspace_edit exactly once with path src/edit.ts, then finish."
    case "capability.managed-resources":
      return "List managed resources, load managed-skill and managed-prompt by id, then call mcp__managed__write_file. Call each exactly once, then finish."
    case "structured.question-plan":
      return "Ask the structured question Continue?, then submit a one-step plan after it is answered."
    case "quality.semantic-references":
      return "Find every semantic reference to token declared on source.ts line 1. Use code intelligence, include source.ts and reexport.ts evidence, and exclude the shadowed local in use.ts."
    case "quality.structural-preview":
      return "Count direct calls named run using structural syntax search. Do not edit. Report that there is one direct call."
    case "quality.semantic-rename":
      return "Use semantic references first, then rename token on source.ts line 1 to credential. Do not use structural edit."
    case "quality.plain-text-skip":
      return "Reply exactly: plain text. Do not inspect code or call a tool."
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
    writeFile(join(root, "src/old.ts"), "export const renamed = true\n"),
    writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts", "src/*.ts"] })),
    writeFile(join(root, "source.ts"), "export const token = 1\nexport const run = () => token\n"),
    writeFile(join(root, "reexport.ts"), "export { token as publicToken } from './source'\n"),
    writeFile(join(root, "use.ts"), "import { publicToken } from './reexport'\nconst token = 2\nrun()\nconst text = 'run()'\n// run()\nexport const value = publicToken + token\n")
  ])
  return root
}

const fileChangeRegistry = (
  root: string,
  observations: Array<EvalObservation>,
  tracker: FileChangeTracker
): ToolRegistry => {
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
    id: "workspace_edit",
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
      observations.push({ kind: "tool-effect", tool: "workspace_edit" })
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

const codeToolRegistry = (
  root: string,
  tracker: FileChangeTracker | undefined
): ToolRegistry => {
  const registry = new ToolRegistry(tracker
    ? {
        observer: createMutationObserver({
          cwd: root,
          runId: "eval-code-run",
          sessionId: "eval-session",
          chatId: "eval-chat",
          tracker,
          journal: new RunJournal({ file: join(root, ".jingler", "code-run.json") })
        })
      }
    : {})
  registerCodeIntelligenceTools(registry, root)
  registerStructuralCodeTools(registry, root)
  return registry
}

const managedResourceRegistry = async (
  root: string,
  observations: Array<EvalObservation>,
  tracker: FileChangeTracker
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
  if (event._tag === "Assistant") {
    observations.push({ kind: "report-text", text: event.text })
  }
  if (event._tag === "ToolStart") {
    observations.push({
      kind: "tool-call",
      tool: event.name,
      risk: registry?.riskFor(event.name) ?? "read"
    })
  }
  if (event._tag === "ToolEnd" && event.output) {
    observations.push({ kind: "report-text", text: event.output })
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
  observations: Array<EvalObservation>,
  tracker: FileChangeTracker | undefined
): Promise<ToolRegistry | undefined> => {
  if (scenarioId.startsWith("quality.")) {
    return codeToolRegistry(root, tracker)
  }
  if (scenarioId === "capability.managed-resources") {
    if (!tracker) throw new Error("managed-resource scenario requires file-change tracking")
    return managedResourceRegistry(root, observations, tracker)
  }
  if (scenarioId !== "permission.denied-edit" && scenarioId !== "diff.create-edit-delete-rename") {
    return
  }
  if (!tracker) throw new Error("workspace-mutation scenario requires file-change tracking")
  return fileChangeRegistry(root, observations, tracker)
}

const scenarioMutatesWorkspace = (scenarioId: string): boolean =>
  scenarioId === "permission.denied-edit" ||
  scenarioId === "diff.create-edit-delete-rename" ||
  scenarioId === "capability.managed-resources" ||
  scenarioId.startsWith("quality.")

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
      targetId: target.capabilities.targetId
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
  targetCapabilities: RuntimeCapabilityManifest,
  observations: Array<EvalObservation>
): void => {
  if (scenarioId === "auth.route-pinned") {
    observations.push({ kind: "auth-route", route: authKind })
  }
  if (scenarioId !== "remote.contract-compatible") return
  observations.push(recordRemoteContractObservation(
    spec.targetCapabilities,
    targetCapabilities
  ))
}

export const recordRemoteContractObservation = (
  expected: RuntimeCapabilityManifest,
  actual: RuntimeCapabilityManifest
): EvalObservation => {
  if (!runtimeCapabilitiesMatch(expected, actual)) {
    throw new Error("execution target runtime contract mismatch")
  }
  return { kind: "event", tag: "RemoteContractAccepted" }
}

interface ScenarioExecution {
  readonly scenarioId: string
  readonly startedAt: number
  readonly root: string
  readonly agentDir: string
  readonly observations: Array<EvalObservation>
  readonly connection: ProviderConnectionType
  readonly credentials: ProviderCredentialStore
  readonly registry: ToolRegistry | undefined
  readonly tracker: FileChangeTracker | undefined
  readonly spec: PiRunSpec
  readonly context: AgentRuntimeContext
  readonly targetCapabilities: RuntimeCapabilityManifest
  readonly configureModelRuntime?: (runtime: ModelRuntime) => void | Promise<void>
}

const executeScenario = async (input: ScenarioExecution): Promise<EvalTrace> => {
  const { scenarioId, startedAt, root, agentDir, observations, connection } = input
  const { credentials, registry, tracker, spec, context } = input
  recordPreflight(
    scenarioId,
    connection.authKind,
    spec,
    input.targetCapabilities,
    observations
  )
  const factory = makePiSessionFactory({
    agentDir,
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
  const assistantText = [...events].flatMap((event) => event._tag === "Assistant" ? [event.text] : []).join("")
  if (assistantText.length > 0) observations.push({ kind: "report-text", text: assistantText })
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
  readonly capabilities: RuntimeCapabilityManifest
}

export interface RunPiScenarioInput {
  readonly scenarioId: string
  readonly connection: ProviderConnectionType
  readonly credentials: ProviderCredentialStore
  readonly target: PiScenarioTarget
  /** Shared process-owned Pi root for concurrent deterministic scenarios. */
  readonly agentDir?: string
  readonly configureModelRuntime?: (runtime: ModelRuntime) => void | Promise<void>
}

export const runPiScenario = async (input: RunPiScenarioInput): Promise<EvalTrace> => {
  const { scenarioId, connection, credentials, target } = input
  const startedAt = performance.now()
  const root = await createWorkspace()
  const agentDir = input.agentDir ??
    process.env.PI_CODING_AGENT_DIR ??
    join(root, ".jingler/agent")
  const observations: Array<EvalObservation> = []
  const tracker = scenarioMutatesWorkspace(scenarioId)
    ? new FileChangeTracker({
        artifactDir: join(root, ".jingler/terminal-diffs"),
        sessionId: "eval-session",
        shadowIndexRoot: root
      })
    : undefined

  try {
    const registry = await registryFor(scenarioId, root, observations, tracker)
    const spec = specFor({ scenarioId, root, connection, target, registry })
    const context = contextFor(scenarioId, observations)
    return await executeScenario({
      scenarioId,
      startedAt,
      root,
      agentDir,
      observations,
      connection,
      credentials,
      registry,
      tracker,
      spec,
      context,
      targetCapabilities: target.capabilities,
      ...(input.configureModelRuntime ? { configureModelRuntime: input.configureModelRuntime } : {})
    })
  } finally {
    if (tracker) await Effect.runPromise(tracker.dispose().pipe(Effect.ignore))
    await rm(root, { recursive: true, force: true })
  }
}
