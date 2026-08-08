import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { AgentRunner } from "@jingler/cli-adapters/agent-runner"
import { AppPaths } from "@jingler/cli-adapters/app-paths"
import { BackgroundTaskStore } from "@jingler/cli-adapters/background-tasks"
import { BrowserControlMcpService } from "@jingler/cli-adapters/browser-control-mcp-service"
import { ConfigService } from "@jingler/cli-adapters/config"
import { ContextManager } from "@jingler/cli-adapters/context-manager"
import { DiscoveryService } from "@jingler/cli-adapters/discovery"
import { GitService } from "@jingler/cli-adapters/git"
import { GitHubApi, parseGitHubRemote } from "@jingler/cli-adapters/github-api"
import { GitHubAuth } from "@jingler/cli-adapters/github-auth"
import { HarnessCliAdapterLive } from "@jingler/cli-adapters/harness-adapter"
import { OpenConnectorService } from "@jingler/cli-adapters/open-connector"
import { PlanStore } from "@jingler/cli-adapters/plan-store"
import { InMemorySecretStoreLive } from "@jingler/cli-adapters/secret-store"
import { SessionStore } from "@jingler/cli-adapters/sessions"
import { TranscriptStore } from "@jingler/cli-adapters/transcripts"
import { WorkspaceService } from "@jingler/cli-adapters/workspace"
import {
  claudePublishMetadataGenerator,
  isCommitSubjectSafe
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
  QuestionAnswer,
  ReasoningSetting,
  RemotePublishCompleteInput,
  RemotePublishPrepared,
  Session,
  StreamEvent
} from "@jingler/core"
import type {
  CreateSessionFromIssueInput as CreateSessionFromIssueInputValue,
  CreateSessionFromPrInput as CreateSessionFromPrInputValue,
  CreateSessionInput as CreateSessionInputValue,
  RemoteSessionCommand,
  RemotePublishPrepared as RemotePublishPreparedValue,
  Session as SessionValue,
  StreamEvent as StreamEventValue
} from "@jingler/core"
import { Data, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import type { SessionCommandExecutor } from "./session-handler.js"

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
const ArchivePayload = Schema.Struct({ reason: ArchiveReason })
const RepoPathPayload = Schema.Struct({ repoPath: Schema.optional(Schema.String) })
const ContinuationPayload = Schema.Struct({ sourceSession: Session })

export interface DeviceExecutorServices {
  readonly create: (input: CreateSessionInputValue) => Promise<SessionValue>
  readonly createFromPr: (input: CreateSessionFromPrInputValue) => Promise<SessionValue>
  readonly createFromIssue: (input: CreateSessionFromIssueInputValue) => Promise<SessionValue>
  readonly continuation: (source: SessionValue) => Promise<SessionValue>
  readonly run: (
    sessionId: string,
    input: Schema.Schema.Type<typeof RunPayload>,
    emit: (event: StreamEventValue) => Promise<void>
  ) => Promise<void>
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
  readonly transcriptPage: (
    input: Schema.Schema.Type<typeof TranscriptPagePayload>
  ) => Promise<unknown>
  readonly diff: (sessionId: string) => Promise<string>
  readonly files: (sessionId: string, repoPath?: string) => Promise<ReadonlyArray<string>>
  readonly branches: (sessionId: string, repoPath?: string) => Promise<ReadonlyArray<string>>
  readonly archive: (sessionId: string, reason: "merged" | "closed") => Promise<SessionValue>
  readonly remove: (sessionId: string) => Promise<void>
  readonly preparePublish: (sessionId: string) => Promise<RemotePublishPreparedValue>
  readonly completePublish: (sessionId: string, prNumber: number) => Promise<SessionValue>
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
      case "Sessions.continueOnEnvironment":
        return services.continuation(decodePayload(command, ContinuationPayload).sourceSession)
      case "Agent.run": {
        const input = decodePayload(command, RunPayload)
        await services.run(command.sessionId, input, (event) => emit({ kind: "event", payload: event }))
        return { status: "complete" }
      }
      case "Agent.decideGate":
        return services.decideGate(command.sessionId, decodePayload(command, DecideGatePayload))
      case "Agent.answerQuestion":
        return services.answerQuestion(command.sessionId, decodePayload(command, AnswerQuestionPayload))
      case "Agent.steer":
        return services.steer(command.sessionId, decodePayload(command, SteerPayload))
      case "Agent.stop":
        return services.stop(command.sessionId, decodePayload(command, ChatIdPayload).chatId)
      case "Sessions.transcriptPage":
        return services.transcriptPage(decodePayload(command, TranscriptPagePayload))
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
      default:
        throw new DeviceOperationError({
          reason: "unsupported",
          operation: command.operation,
          message: `Remote operation ${command.operation} is not supported by this device agent.`
        })
    }
  }
})

const appPathsLayer = (root: string) => Layer.succeed(AppPaths, {
  root,
  configFile: join(root, "config.json"),
  sessionsFile: join(root, "sessions.json"),
  worktreesDir: join(root, "worktrees"),
  transcriptsDir: join(root, "transcripts"),
  reviewsDir: join(root, "reviews"),
  plansDir: join(root, ".jingler"),
  themesDir: join(root, "themes"),
  pluginsDir: join(root, "plugins"),
  pluginStorageDir: join(root, "plugin-storage"),
  authFile: join(root, "auth.enc"),
  openConnectorFile: join(root, "open-connector.enc")
})

/** Headless devices have no embedded browser; harness injection receives no browser MCP. */
const HeadlessBrowserControlLive = Layer.succeed(
  BrowserControlMcpService,
  BrowserControlMcpService.of({
    acquire: () => Effect.succeed(null),
    revoke: () => Effect.void
  })
)

const deviceRuntime = (root: string) => {
  const services = Layer.mergeAll(
    AgentRunner.Default,
    SessionStore.Default,
    TranscriptStore.Default,
    BackgroundTaskStore.Default,
    PlanStore.Default,
    ContextManager.Default,
    DiscoveryService.Default,
    ConfigService.Default,
    GitHubApi.Default.pipe(Layer.provideMerge(GitHubAuth.Default)),
    GitService.Default,
    WorkspaceService.Default,
    OpenConnectorService.Default
  ).pipe(
    Layer.provideMerge(HarnessCliAdapterLive),
    Layer.provideMerge(HeadlessBrowserControlLive),
    Layer.provideMerge(InMemorySecretStoreLive),
    Layer.provideMerge(appPathsLayer(root)),
    Layer.provideMerge(NodeContext.layer)
  )
  return ManagedRuntime.make(services)
}

const deviceSession = (sessionId: string) => SessionStore.get(sessionId)

/** Install the real cli-adapters runtime used by the `serve` command. */
export const makeLiveDeviceSessionCommandExecutor = (
  jinglerRoot: string
): SessionCommandExecutor => {
  const runtime = deviceRuntime(jinglerRoot)
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

  return makeDeviceSessionCommandExecutor({
    create: (input) => run(SessionStore.create(input)),
    createFromPr: (input) => run(SessionStore.createFromPr(input)),
    createFromIssue: (input) => run(SessionStore.createFromIssue(input)),
    continuation: (source) => run(SessionStore.create({
      ...(source.environmentId === undefined ? {} : { environmentId: source.environmentId }),
      repoPath: source.repoPath ?? source.worktreePath ?? "",
      repoName: source.repo,
      title: source.title,
      cli: source.cli,
      baseBranch: source.baseBranch ?? source.branch,
      useWorktree: true
    })),
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
        const metadata = yield* claudePublishMetadataGenerator.generate({
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
    )
  })
}
