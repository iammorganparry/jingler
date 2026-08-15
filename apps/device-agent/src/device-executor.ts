import { createHash } from "node:crypto"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { AgentRuntime } from "@jingler/cli-adapters/runtime/agent/agent-runtime"
import { AgentTurnDriverLive } from "@jingler/cli-adapters/runtime/agent/agent-turn-driver-live"
import {
  makePiAgentRuntimeLive
} from "@jingler/cli-adapters/runtime/agent/pi-runtime-live"
import { RuntimeDiagnostics } from "@jingler/cli-adapters/runtime/diagnostics/runtime-diagnostics"
import { AgentResourcesLive } from "@jingler/cli-adapters/runtime/resources/resource-services-live"
import { AssetService } from "@jingler/cli-adapters/asset"
import { AgentRunner } from "@jingler/cli-adapters/agent-runner"
import { AppPaths } from "@jingler/cli-adapters/app-paths"
import { makeAppPaths } from "@jingler/cli-adapters/app-paths-factory"
import { BackgroundTaskStore } from "@jingler/cli-adapters/background-tasks"
import { BrowserControlMcpService } from "@jingler/cli-adapters/browser-control-mcp-service"
import { ConfigService } from "@jingler/cli-adapters/config"
import { ContextManager } from "@jingler/cli-adapters/context-manager"
import { GitService } from "@jingler/cli-adapters/git"
import { GitHubApi, parseGitHubRemote } from "@jingler/cli-adapters/github-api"
import { GitHubAuth } from "@jingler/cli-adapters/github-auth"
import { OpenConnectorService } from "@jingler/cli-adapters/open-connector"
import {
  managedWebSearchServiceFromEnvironment,
  WebSearchService
} from "@jingler/cli-adapters/web-search"
import { PlanStore } from "@jingler/cli-adapters/plan-store"
import { ProjectService } from "@jingler/cli-adapters/projects"
import { SessionStore } from "@jingler/cli-adapters/sessions"
import { TranscriptStore } from "@jingler/cli-adapters/transcripts"
import { WorkspaceService } from "@jingler/cli-adapters/workspace"
import {
  checkoutWorkspaceHandoffBase,
  exportWorkspaceHandoff,
  importWorkspaceHandoff
} from "@jingler/cli-adapters/workspace-handoff"
import {
  isCommitSubjectSafe,
  makeAgentRuntimePublishMetadataGenerator
} from "@jingler/cli-adapters/publish-metadata"
import { isSessionPublishBranchReady } from "@jingler/cli-adapters/sessions"
import {
  ArchiveReason,
  Attachment,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  ExternalInstructionIdentity,
  GateDecision,
  Message,
  OwnedDeviceOffloadBegin as OwnedOffloadBegin,
  OwnedDeviceOffloadChunk as OwnedOffloadChunk,
  OwnedDeviceOffloadExecute as OwnedOffloadExecute,
  QuestionAnswer,
  ReasoningSetting,
  Project,
  RemotePublishCompleteInput,
  RemotePublishPrepared,
  Session,
  StreamEvent,
  SubagentFleetControlRequest,
  SubagentFleetSnapshot,
  WorkspaceTransferCheckpoint
} from "@jingler/core"
import type {
  CreateSessionFromIssueInput as CreateSessionFromIssueInputValue,
  CreateSessionFromPrInput as CreateSessionFromPrInputValue,
  CreateSessionInput as CreateSessionInputValue,
  RemoteSessionCommand,
  RemotePublishPrepared as RemotePublishPreparedValue,
  OwnedDeviceOffloadResult as OwnedOffloadResult,
  Session as SessionValue,
  Project as ProjectValue,
  Message as MessageValue,
  StreamEvent as StreamEventValue,
  SubagentFleetControlOutcome as SubagentFleetControlOutcomeValue,
  SubagentFleetControlRequest as SubagentFleetControlRequestValue,
  SubagentFleetSnapshot as SubagentFleetSnapshotValue
} from "@jingler/core"
import { loadDeviceE2ePiRuntime } from "./e2e/pi-runtime.js"
import { Data, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import type { SessionCommandExecutor } from "./session-handler.js"
import { makeOwnedDeviceOffloadExecutor } from "./offload-device.js"
import { makeDeviceProviderLayers } from "./provider-runtime.js"
import { makeDeviceSecretStoreLive } from "./device-secret-store.js"

type JsonRecord = Readonly<Record<string, unknown>>

export class DeviceOperationError extends Data.TaggedError("DeviceOperationError")<{
  readonly reason: "invalid-payload" | "unsupported"
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

const payloadRecord = (command: RemoteSessionCommand): JsonRecord => {
  if (typeof command.payload !== "object" || command.payload === null || Array.isArray(command.payload)) {
    throw new DeviceOperationError({
      reason: "invalid-payload",
      operation: command.operation,
      message: `Remote operation ${command.operation} requires an object payload.`
    })
  }
  return command.payload as JsonRecord
}

const decodePayload = <A, I>(
  command: RemoteSessionCommand,
  schema: Schema.Schema<A, I>,
  value: unknown = command.payload
): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" })
  } catch (cause) {
    throw new DeviceOperationError({
      reason: "invalid-payload",
      operation: command.operation,
      message: `Remote operation ${command.operation} received an invalid payload.`,
      cause
    })
  }
}

const ChatIdPayload = Schema.Struct({ chatId: Schema.String })
const SubagentFleetSnapshotPayload = Schema.Struct({
  chatId: Schema.String,
  parentPiSessionId: Schema.String
})
const SubagentTranscriptPayload = Schema.Struct({
  chatId: Schema.String,
  parentPiSessionId: Schema.String,
  runId: Schema.String
})
const SubagentControlPayload = Schema.Struct({
  chatId: Schema.String,
  request: SubagentFleetControlRequest
})
const RunPayload = Schema.Struct({
  chatId: Schema.String,
  text: Schema.String,
  displayText: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Attachment)),
  reasoning: Schema.optional(Schema.NullOr(ReasoningSetting)),
  externalInstruction: Schema.optional(ExternalInstructionIdentity)
})
const DecideGatePayload = Schema.Struct({
  chatId: Schema.String,
  gateId: Schema.String,
  decision: GateDecision
})
const AnswerQuestionPayload = Schema.Struct({
  chatId: Schema.String,
  requestId: Schema.String,
  answers: Schema.Array(QuestionAnswer)
})
const SteerPayload = Schema.Struct({
  chatId: Schema.String,
  text: Schema.String,
  images: Schema.optional(Schema.Array(Attachment))
})
const TranscriptPagePayload = Schema.Struct({
  chatId: Schema.String,
  before: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number)
})
const TranscriptPageResult = Schema.Struct({
  messages: Schema.Array(Message),
  hasMore: Schema.Boolean,
  cursor: Schema.optional(Schema.String)
})

const stripTranscriptAttachmentData = (
  page: Schema.Schema.Type<typeof TranscriptPageResult>
): Schema.Schema.Type<typeof TranscriptPageResult> => ({
  ...page,
  messages: page.messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) =>
      part._tag === "Image"
        ? { ...part, attachment: { ...part.attachment, data: "" } }
        : part
    )
  }))
})
const ArchivePayload = Schema.Struct({ reason: ArchiveReason })
const RepoPathPayload = Schema.Struct({ repoPath: Schema.optional(Schema.String) })
const ContinuationPayload = Schema.Struct({
  sourceSession: Session,
  requestedSessionId: Schema.optional(Schema.String)
})
const ProjectRegisterPayload = Schema.Struct({
  path: Schema.String,
  name: Schema.optional(Schema.String)
})
const ProjectClonePayload = Schema.Struct({
  url: Schema.String,
  destination: Schema.String,
  name: Schema.optional(Schema.String)
})
const ProjectEnsurePayload = Schema.Struct({
  url: Schema.String,
  name: Schema.String
})
const ProjectIdPayload = Schema.Struct({ id: Schema.String })
const ExportHandoffPayload = Schema.Struct({
  eventCursor: Schema.Int.pipe(Schema.nonNegative())
})
const ImportHandoffPayload = Schema.Struct({ checkpoint: WorkspaceTransferCheckpoint })
const ImportConversationPayload = Schema.Struct({ messages: Schema.Array(Message) })

export interface DeviceExecutorServices {
  readonly create: (input: CreateSessionInputValue) => Promise<SessionValue>
  readonly createFromPr: (input: CreateSessionFromPrInputValue) => Promise<SessionValue>
  readonly createFromIssue: (input: CreateSessionFromIssueInputValue) => Promise<SessionValue>
  readonly continuation: (
    source: SessionValue,
    requestedSessionId?: string
  ) => Promise<SessionValue>
  readonly listProjects: () => Promise<ReadonlyArray<ProjectValue>>
  readonly registerProject: (input: Schema.Schema.Type<typeof ProjectRegisterPayload>) => Promise<ProjectValue>
  readonly createProjectDirectory: (input: Schema.Schema.Type<typeof ProjectRegisterPayload>) => Promise<ProjectValue>
  readonly cloneProject: (input: Schema.Schema.Type<typeof ProjectClonePayload>) => Promise<ProjectValue>
  readonly ensureProject: (input: Schema.Schema.Type<typeof ProjectEnsurePayload>) => Promise<ProjectValue>
  readonly removeProject: (id: string) => Promise<void>
  readonly run: (
    sessionId: string,
    input: Schema.Schema.Type<typeof RunPayload>,
    emit: (event: StreamEventValue) => Promise<void>
  ) => Promise<SessionValue>
  readonly decideGate: (
    sessionId: string,
    input: Schema.Schema.Type<typeof DecideGatePayload>
  ) => Promise<void>
  readonly answerQuestion: (
    sessionId: string,
    input: Schema.Schema.Type<typeof AnswerQuestionPayload>
  ) => Promise<void>
  readonly steer: (
    sessionId: string,
    input: Schema.Schema.Type<typeof SteerPayload>
  ) => Promise<unknown>
  readonly stop: (sessionId: string, chatId: string) => Promise<void>
  readonly subagentFleetSnapshot: (
    sessionId: string,
    chatId: string,
    parentPiSessionId: string
  ) => Promise<SubagentFleetSnapshotValue>
  readonly subagentTranscript: (
    sessionId: string,
    chatId: string,
    parentPiSessionId: string,
    runId: string
  ) => Promise<ReadonlyArray<MessageValue>>
  readonly controlSubagent: (
    sessionId: string,
    chatId: string,
    input: SubagentFleetControlRequestValue
  ) => Promise<SubagentFleetControlOutcomeValue>
  readonly transcriptPage: (
    input: Schema.Schema.Type<typeof TranscriptPagePayload>
  ) => Promise<unknown>
  readonly diff: (sessionId: string) => Promise<string>
  readonly files: (sessionId: string, repoPath?: string) => Promise<ReadonlyArray<string>>
  readonly branches: (sessionId: string, repoPath?: string) => Promise<ReadonlyArray<string>>
  readonly exportHandoff: (sessionId: string, eventCursor: number) => Promise<unknown>
  readonly importHandoff: (sessionId: string, checkpoint: unknown) => Promise<void>
  readonly importConversation: (sessionId: string, messages: ReadonlyArray<unknown>) => Promise<void>
  readonly archive: (sessionId: string, reason: "merged" | "closed") => Promise<SessionValue>
  readonly remove: (sessionId: string) => Promise<void>
  readonly preparePublish: (sessionId: string) => Promise<RemotePublishPreparedValue>
  readonly completePublish: (sessionId: string, prNumber: number) => Promise<SessionValue>
  readonly beginOffload: (input: Schema.Schema.Type<typeof OwnedOffloadBegin>) => Promise<void>
  readonly appendOffloadChunk: (input: Schema.Schema.Type<typeof OwnedOffloadChunk>) => Promise<void>
  readonly executeOffload: (input: Schema.Schema.Type<typeof OwnedOffloadExecute>) => Promise<OwnedOffloadResult>
  readonly cancelOffload: (input: Schema.Schema.Type<typeof OwnedOffloadExecute>) => Promise<void>
}

/**
 * Production device dispatcher. Every operation is explicitly device-local;
 * unknown symbols fail rather than falling back to the desktop.
 */
export const makeDeviceSessionCommandExecutor = (
  services: DeviceExecutorServices
): SessionCommandExecutor => ({
  execute: async (command, emit) => {
    switch (command.operation) {
      case "Sessions.create":
        return services.create(decodePayload(command, CreateSessionInput))
      case "Sessions.createFromPr":
        return services.createFromPr(decodePayload(command, CreateSessionFromPrInput))
      case "Sessions.createFromIssue":
        return services.createFromIssue(decodePayload(command, CreateSessionFromIssueInput))
      case "Sessions.continueOnEnvironment": {
        const input = decodePayload(command, ContinuationPayload)
        return services.continuation(input.sourceSession, input.requestedSessionId)
      }
      case "Projects.list":
        payloadRecord(command)
        return services.listProjects()
      case "Projects.register":
        return services.registerProject(decodePayload(command, ProjectRegisterPayload))
      case "Projects.createDirectory":
        return services.createProjectDirectory(decodePayload(command, ProjectRegisterPayload))
      case "Projects.clone":
        return services.cloneProject(decodePayload(command, ProjectClonePayload))
      case "Projects.ensure":
        return services.ensureProject(decodePayload(command, ProjectEnsurePayload))
      case "Projects.remove":
        return services.removeProject(decodePayload(command, ProjectIdPayload).id)
      case "Agent.run": {
        const input = decodePayload(command, RunPayload)
        const session = await services.run(
          command.sessionId,
          input,
          (event) => emit({ kind: "event", payload: event })
        )
        return { status: "complete", session }
      }
      case "Agent.decideGate":
        return services.decideGate(command.sessionId, decodePayload(command, DecideGatePayload))
      case "Agent.answerQuestion":
        return services.answerQuestion(command.sessionId, decodePayload(command, AnswerQuestionPayload))
      case "Agent.steer":
        return services.steer(command.sessionId, decodePayload(command, SteerPayload))
      case "Agent.stop":
        return services.stop(command.sessionId, decodePayload(command, ChatIdPayload).chatId)
      case "Agent.subagentFleetSnapshot": {
        const input = decodePayload(command, SubagentFleetSnapshotPayload)
        return services.subagentFleetSnapshot(
          command.sessionId,
          input.chatId,
          input.parentPiSessionId
        )
      }
      case "Agent.subagentTranscript": {
        const input = decodePayload(command, SubagentTranscriptPayload)
        return services.subagentTranscript(
          command.sessionId,
          input.chatId,
          input.parentPiSessionId,
          input.runId
        )
      }
      case "Agent.controlSubagent": {
          const input = decodePayload(command, SubagentControlPayload)
          return services.controlSubagent(
            command.sessionId,
            input.chatId,
            input.request
          )
        }
      case "Sessions.transcriptPage": {
        const page = await services.transcriptPage(
          decodePayload(command, TranscriptPagePayload)
        )
        return stripTranscriptAttachmentData(
          decodePayload(command, TranscriptPageResult, page)
        )
      }
      case "Sessions.diff":
        payloadRecord(command)
        return services.diff(command.sessionId)
      case "Workspace.files": {
        const input = decodePayload(command, RepoPathPayload)
        return services.files(command.sessionId, input.repoPath)
      }
      case "Workspace.branches": {
        const input = decodePayload(command, RepoPathPayload)
        return services.branches(command.sessionId, input.repoPath)
      }
      case "Workspace.exportHandoff":
        return services.exportHandoff(
          command.sessionId,
          decodePayload(command, ExportHandoffPayload).eventCursor
        )
      case "Workspace.importHandoff":
        return services.importHandoff(
          command.sessionId,
          decodePayload(command, ImportHandoffPayload).checkpoint
        )
      case "Sessions.importConversation":
        return services.importConversation(
          command.sessionId,
          decodePayload(command, ImportConversationPayload).messages
        )
      case "Sessions.archive":
        return services.archive(command.sessionId, decodePayload(command, ArchivePayload).reason)
      case "Sessions.delete":
        payloadRecord(command)
        return services.remove(command.sessionId)
      case "Github.preparePublish":
        payloadRecord(command)
        return services.preparePublish(command.sessionId)
      case "Github.completePublish":
        return services.completePublish(
          command.sessionId,
          decodePayload(command, RemotePublishCompleteInput).prNumber
        )
      case "Offload.begin":
        return services.beginOffload(decodePayload(command, OwnedOffloadBegin))
      case "Offload.chunk":
        return services.appendOffloadChunk(decodePayload(command, OwnedOffloadChunk))
      case "Offload.execute":
        return services.executeOffload(decodePayload(command, OwnedOffloadExecute))
      case "Offload.cancel":
        return services.cancelOffload(decodePayload(command, OwnedOffloadExecute))
      default:
        throw new DeviceOperationError({
          reason: "unsupported",
          operation: command.operation,
          message: `Remote operation ${command.operation} is not supported by this device agent.`
        })
    }
  }
})

const appPathsLayer = (root: string) =>
  Layer.succeed(AppPaths, makeAppPaths(root))

/** Headless devices have no embedded browser; harness injection receives no browser MCP. */
const HeadlessBrowserControlLive = Layer.succeed(
  BrowserControlMcpService,
  BrowserControlMcpService.of({
    acquire: () => Effect.succeed(null),
    revoke: () => Effect.void
  })
)

const deviceRuntime = (root: string, targetId: string) => {
  const e2eRuntime = loadDeviceE2ePiRuntime(targetId)
  const providers = makeDeviceProviderLayers(
    targetId,
    process.env,
    e2eRuntime?.providers,
    (initialDeviceSecrets) => {
      const paths = makeAppPaths(root)
      return makeDeviceSecretStoreLive(
        paths.deviceIdentityFile,
        paths.deviceSecretsFile,
        initialDeviceSecrets
      )
    }
  )
  const assets = AssetService.Default.pipe(Layer.provide(NodeContext.layer))
  const embeddedPi = makePiAgentRuntimeLive({
    configureModelRuntime: async (runtime) => {
      providers.configureModelRuntime(runtime)
      await e2eRuntime?.configureModelRuntime(runtime)
    }
  })
  const managedWebSearch = managedWebSearchServiceFromEnvironment(process.env)
  const embeddedWithSearch = managedWebSearch === null
    ? embeddedPi
    : embeddedPi.pipe(
        Layer.provide(Layer.succeed(WebSearchService, managedWebSearch))
      )
  const piRuntime = embeddedWithSearch.pipe(
    Layer.provide(ConfigService.Default),
    Layer.provide(GitService.Default),
    Layer.provide(RuntimeDiagnostics.Default),
    Layer.provide(assets),
    Layer.provide(AgentResourcesLive),
    Layer.provide(providers.ProviderConnectionsLive),
    Layer.provide(providers.SecretStoreLive)
  )
  const agentExecution = AgentTurnDriverLive.pipe(
    Layer.provideMerge(piRuntime)
  )
  const services = Layer.mergeAll(
    AgentRunner.Default,
    SessionStore.Default,
    TranscriptStore.Default,
    BackgroundTaskStore.Default,
    PlanStore.Default,
    ProjectService.Default,
    ContextManager.Default,
    ConfigService.Default,
    GitHubApi.Default.pipe(Layer.provideMerge(GitHubAuth.Default)),
    GitService.Default,
    WorkspaceService.Default,
    OpenConnectorService.Default
  ).pipe(
    Layer.provideMerge(agentExecution),
    Layer.provideMerge(HeadlessBrowserControlLive),
    Layer.provideMerge(providers.SecretStoreLive),
    Layer.provideMerge(appPathsLayer(root)),
    Layer.provideMerge(NodeContext.layer)
  )
  return ManagedRuntime.make(services)
}

const deviceSession = (sessionId: string) => SessionStore.get(sessionId)

const normalizedRemoteUrl = (value: string): string =>
  value
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "")
    .toLowerCase()

const safeProjectDirectory = (name: string): string => {
  const safe = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "")
  return safe || "project"
}

/** Install the real cli-adapters runtime used by the `serve` command. */
export const makeLiveDeviceSessionCommandExecutor = (
  jinglerRoot: string,
  targetId = "device"
): SessionCommandExecutor => {
  const runtime = deviceRuntime(jinglerRoot, targetId)
  const offload = makeOwnedDeviceOffloadExecutor(jinglerRoot)
  // ManagedRuntime has every service retained by `deviceRuntime`; preserve the
  // individual operation's error channel while closing its environment here.
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    runtime.runPromise(effect as Effect.Effect<A, E, never>)
  const repoPath = (sessionId: string, explicit?: string) =>
    explicit === undefined
      ? deviceSession(sessionId).pipe(
          Effect.flatMap((session) =>
            session.worktreePath
              ? Effect.succeed(session.worktreePath)
              : Effect.fail(new Error(`Session ${sessionId} has no workspace.`))
          )
        )
      : Effect.succeed(explicit)

  const listProjects = Effect.gen(function* () {
    const discovered = yield* WorkspaceService.listRepos().pipe(Effect.orElseSucceed(() => []))
    return yield* ProjectService.backfill(
      discovered.map((repository) => ({ path: repository.path, name: repository.name }))
    )
  })

  return makeDeviceSessionCommandExecutor({
    create: (input) => run(SessionStore.create(input)),
    createFromPr: (input) => run(SessionStore.createFromPr(input)),
    createFromIssue: (input) => run(SessionStore.createFromIssue(input)),
    continuation: (source, requestedSessionId) => run(Effect.gen(function* () {
      if (
        source.connectionId === undefined ||
        source.providerId === undefined ||
        source.modelId === undefined
      ) {
        return yield* Effect.fail(
          new Error("The source session needs a certified provider connection before continuation.")
        )
      }
      return yield* SessionStore.create({
        ...(source.environmentId === undefined ? {} : { environmentId: source.environmentId }),
        ...(requestedSessionId === undefined ? {} : { requestedSessionId }),
        repoPath: source.repoPath ?? source.worktreePath ?? "",
        repoName: source.repo,
        title: source.title,
        connectionId: source.connectionId,
        providerId: source.providerId,
        modelId: source.modelId,
        baseBranch: source.baseBranch ?? source.branch,
        useWorktree: true
      })
    })),
    listProjects: () => run(listProjects),
    registerProject: (input) => run(ProjectService.register(input)),
    createProjectDirectory: (input) => run(ProjectService.createDirectory(input)),
    cloneProject: (input) => run(ProjectService.clone(input)),
    ensureProject: (input) => run(Effect.gen(function* () {
      const projects = yield* listProjects
      const wanted = normalizedRemoteUrl(input.url)
      for (const project of projects.filter((candidate) => candidate.availability === "available")) {
        const remote = yield* GitService.remoteUrl(project.path).pipe(Effect.orElseSucceed(() => null))
        if (remote !== null && normalizedRemoteUrl(remote) === wanted) return project
      }

      const config = yield* ConfigService.get()
      if (config === null || config.reposDir === null) {
        return yield* Effect.fail(new Error("The remote host has no repository directory configured."))
      }
      const directory = safeProjectDirectory(input.name)
      const collision = projects.some((project) => project.path === join(config.reposDir!, directory))
      const suffix = createHash("sha256").update(wanted).digest("hex").slice(0, 8)
      return yield* ProjectService.clone({
        url: input.url,
        destination: join(config.reposDir, collision ? `${directory}-${suffix}` : directory),
        name: input.name
      })
    })),
    removeProject: (id) => run(ProjectService.remove(id)),
    run: (sessionId, input, emit) => run(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.prompt(
          sessionId,
          input.chatId,
          input.text,
          input.images ?? [],
          input.reasoning,
          undefined,
          input.externalInstruction,
          input.displayText
        ).pipe(Stream.runForEach((event) => Effect.promise(() => emit(event))))
        return yield* SessionStore.get(sessionId)
      })
    ),
    decideGate: (sessionId, input) => run(
      Effect.flatMap(AgentRunner, (runner) =>
        runner.decideGate(sessionId, input.chatId, input.gateId, input.decision)
      )
    ),
    answerQuestion: (sessionId, input) => run(
      Effect.flatMap(AgentRunner, (runner) =>
        runner.answerQuestion(sessionId, input.chatId, input.requestId, input.answers)
      )
    ),
    steer: (sessionId, input) => run(
      Effect.flatMap(AgentRunner, (runner) =>
        runner.steer(sessionId, input.chatId, input.text, input.images ?? [])
      )
    ),
    stop: (sessionId, chatId) => run(
      Effect.flatMap(AgentRunner, (runner) => runner.stop(sessionId, chatId))
    ),
    subagentFleetSnapshot: (sessionId, chatId, parentPiSessionId) => run(
      Effect.flatMap(
        AgentRuntime,
        (runtime) => runtime.subagentFleetSnapshot(
          sessionId,
          chatId,
          parentPiSessionId
        )
      )
    ),
    subagentTranscript: (
      sessionId,
      chatId,
      parentPiSessionId,
      runId
    ) => run(
      Effect.flatMap(
        AgentRuntime,
        (runtime) => runtime.subagentTranscript(
          sessionId,
          chatId,
          parentPiSessionId,
          runId
        )
      )
    ),
    controlSubagent: (sessionId, chatId, input) => run(
      Effect.flatMap(
        AgentRuntime,
        (runtime) => runtime.controlSubagent(sessionId, chatId, input)
      )
    ),
    transcriptPage: (input) => run(TranscriptStore.listPage(input.chatId, {
      ...(input.before === undefined ? {} : { before: input.before }),
      limit: input.limit ?? 100
    })),
    diff: (sessionId) => run(
      repoPath(sessionId).pipe(Effect.flatMap((path) => WorkspaceService.diff(path)))
    ),
    files: (sessionId, explicit) => run(
      repoPath(sessionId, explicit).pipe(Effect.flatMap((path) => WorkspaceService.files(path)))
    ),
    branches: (sessionId, explicit) => run(
      repoPath(sessionId, explicit).pipe(Effect.flatMap((path) => WorkspaceService.branches(path)))
    ),
    exportHandoff: (sessionId, eventCursor) => run(
      repoPath(sessionId).pipe(
        Effect.flatMap((path) => Effect.tryPromise(() => exportWorkspaceHandoff({
          workspacePath: path,
          sourceSessionId: sessionId,
          eventCursor
        })))
      )
    ),
    importHandoff: (sessionId, checkpoint) => run(
      repoPath(sessionId).pipe(
        Effect.flatMap((path) => Effect.tryPromise(async () => {
          const decoded = Schema.decodeUnknownSync(WorkspaceTransferCheckpoint)(checkpoint, {
            onExcessProperty: "error"
          })
          await checkoutWorkspaceHandoffBase(path, decoded)
          await importWorkspaceHandoff(path, decoded)
        }))
      )
    ),
    importConversation: (sessionId, messages) => run(
      Effect.gen(function* () {
        const session = yield* SessionStore.get(sessionId)
        for (const message of messages) {
          yield* TranscriptStore.append(
            session.activeChatId,
            Schema.decodeUnknownSync(Message)(message, { onExcessProperty: "error" })
          )
        }
      })
    ),
    archive: (sessionId, reason) => run(
      SessionStore.archive(sessionId, reason).pipe(Effect.andThen(SessionStore.get(sessionId)))
    ),
    remove: (sessionId) => run(
      Effect.gen(function* () {
        const session = yield* SessionStore.get(sessionId).pipe(Effect.orElseSucceed(() => null))
        const runner = yield* AgentRunner
        for (const chat of [...(session?.chats ?? []), ...(session?.closedChats ?? [])]) {
          yield* runner.stop(sessionId, chat.id, true)
          yield* TranscriptStore.remove(chat.id)
          yield* ContextManager.forget(chat.id)
        }
        yield* BackgroundTaskStore.clear(sessionId)
        yield* SessionStore.remove(sessionId)
      })
    ),
    preparePublish: (sessionId) => run(
      Effect.gen(function* () {
        const session = yield* SessionStore.get(sessionId)
        if (!session.worktreePath) {
          return yield* Effect.fail(new Error("This remote session has no worktree to publish."))
        }
        const cwd = session.worktreePath
        const inspection = yield* GitService.publishInspection(cwd, session.baseBranch ?? "main")
        if (session.semanticBranchPending === true || !inspection.branch) {
          return yield* Effect.fail(new Error("Finish creating the remote task branch before publishing."))
        }
        if (inspection.branch !== session.branch || !isSessionPublishBranchReady(session, inspection.branch)) {
          return yield* Effect.fail(new Error("The remote worktree is not on its validated session branch."))
        }
        const messages = yield* TranscriptStore.list(session.activeChatId)
        const agentRuntime = yield* AgentRuntime
        const metadata = yield* makeAgentRuntimePublishMetadataGenerator(agentRuntime).generate({
          session,
          messages,
          changedPaths: inspection.changedPaths,
          diffSummary: inspection.diffSummary
        })
        if (!isCommitSubjectSafe(metadata.commitMessage)) {
          return yield* Effect.fail(new Error("The generated commit subject was not safe to publish."))
        }
        let commitSha = inspection.headSha
        if (inspection.hasChanges) {
          yield* GitService.stageAll(cwd)
          if (!(yield* GitService.hasStagedChanges(cwd))) {
            return yield* Effect.fail(new Error("Git found no staged remote changes to commit."))
          }
          commitSha = yield* GitService.commit(cwd, metadata.commitMessage)
        }
        if (!commitSha) {
          return yield* Effect.fail(new Error("Git did not return the remote commit SHA."))
        }
        const remote = yield* GitService.remoteUrl(cwd)
        const parsed = remote ? parseGitHubRemote(remote) : null
        if (!parsed) {
          return yield* Effect.fail(new Error("The remote origin is not a github.com repository."))
        }
        yield* GitService.pushConfigured(cwd, inspection.branch)
        return Schema.decodeUnknownSync(RemotePublishPrepared)({
          version: 1,
          sessionId,
          githubSlug: `${parsed.owner}/${parsed.repo}`,
          branch: inspection.branch,
          baseBranch: session.baseBranch ?? "main",
          commitSha,
          commitMessage: metadata.commitMessage,
          prTitle: metadata.prTitle,
          prBody: metadata.prBody,
          existingPrNumber: session.prNumber ?? null
        })
      })
    ),
    completePublish: (sessionId, prNumber) => run(
      SessionStore.setPrNumber(sessionId, prNumber).pipe(
        Effect.andThen(SessionStore.get(sessionId))
      )
    ),
    beginOffload: offload.begin,
    appendOffloadChunk: offload.chunk,
    executeOffload: offload.execute,
    cancelOffload: offload.cancel
  })
}
