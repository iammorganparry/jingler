import { archiveMetadataOnly } from "./metadata-only-archive.js"
import { RoutinesService } from "./routines.js"
import { AssetWriteIoError } from "@jingler/core";
import { TerminalError } from "@jingler/core";
import { readyWorkspacePreview } from "@jingler/cli-adapters/project-workflow";
import { workspaceEnvironment, workspacePortAvailable } from "@jingler/cli-adapters/workspace-ports";
import { BUILTIN_SKILLS } from "@jingler/cli-adapters"
import { probeOpenCodeEndpoint } from "@jingler/cli-adapters/runtime/opencode/endpoint"
import { probeCodexEndpoint, codexEndpointLogin } from "@jingler/cli-adapters"
/**
 * RPC transport — the crux of the app.
 *
 * APPROACH: the real `@effect/rpc` machinery, wired over Electron IPC with a
 * pair of *custom Protocols* (NOT the hand-rolled dispatch fallback). The main
 * process runs `RpcServer` and the renderer runs `RpcClient`; both are driven
 * by the shared `JinglerRpcs` group, which stays the single source of truth for
 * every payload/success/error schema. The only thing crossing the IPC boundary
 * is already-encoded, JSON-safe `FromClientEncoded` / `FromServerEncoded` frames
 * on one channel (`RPC_CHANNEL`); RpcServer/RpcClient own all schema
 * encode/decode. (We avoid the no-serialization path because its *decoded*
 * frames carry Effect `Exit`/`Cause` class instances that don't survive
 * Electron's structured-clone IPC.)
 */
import {
  EMPTY_REVIEW_DIFF,
  AgentRunner,
  AgentRuntime,
  runtimeOwnerForSession,
  AppPaths,
  AssetService,
  AuthService,
  BrowserControlMcpService,
  type AgentTurnDriver,
  ConfigService,
  WebSearchCredentialService,
  makeAgentRuntimeTitleGenerator,
  makeOffloadCommandRouter,
  projectPiEndpointCatalog,
  probeClaudeEndpoint,
  EnvironmentService,
  ExplanationStore,
  RemoteSessionService,
  routeSessionOperation,
  GitHubApi,
  parseGitHubRemote,
  GitHubAuth,
  githubPushPermissions,
  GitHubEventStore,
  GitService,
  SecretStore,
  McpAuthStore,
  startMcpOAuthAuthorization,
  planDraftPost,
  PluginRegistry,
  PluginSecretStore,
  type PluginSecretStoreUnavailable,
  PluginHost,
  type PluginHostRuntime,
  PluginAuth,
  ProjectService,
  planReviewPost,
  retitleSession,
  retitleCreatedSessionFromPrompt,
  ReviewService,
  ReviewStore,
  SessionStore,
  setSessionEnvironment,
  continueSessionOnEnvironment,
  environmentRuntimeIsCurrent,
  ContextManager,
  TerminalService,
  ThemeService,
  BackgroundTaskStore,
  TranscriptStore,
  makeAgentRuntimePublishMetadataGenerator,
  isCommitSubjectSafe,
  isSessionPublishBranchReady,
  runPublishMachineExclusive,
  UsageService,
  UsageFactStore,
  fetchPiProviderUsage,
  routePeerAgentMessage,
  adoptableChatIdentities,
  sessionNeedsRuntimeIdentity,
  WorkspaceService,
  WorkspaceWorkflowService,
  WorkspaceCheckpointService,
  closeWorkspaceAdmission,
  reopenWorkspaceAdmission,
  waitForWorkspaceIdle,
  RuntimeDiagnostics,
  RuntimeRecoveryService,
  disposeLanguageIntelligence,
  languageHover,
  ProviderConnections,
  type ProviderConnectionsShape,
  AgentResourceService,
  McpConfigService,
  probeAll,
  parseClaudeMcp,
  parseCodexMcp,
  parseOpencodeMcp,
  type McpImportCandidate,
  detectAgentResources,
  exportWorkspaceHandoff,
  checkoutWorkspaceHandoffBase,
  importWorkspaceHandoff,
  branchAt,
} from "@jingler/cli-adapters";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AssetUnsupportedError,
  AuthError,
  ConfigError,
  GitHubApiError,
  GitError,
  IssueComment,
  IssueDetail,
  type IssueIdentity,
  type IssueReference,
  IssueSummary,
  issueReferenceForProvider,
  resolveFindings,
  ReviewError,
  PluginError,
  SessionNotFoundError,
  workspaceModeOf,
  createWorkspaceProvisioningPlan,
  defaultModeFor,
  WorkspaceTransferCheckpoint as WorkspaceTransferCheckpointSchema,
  EnvironmentHandoffError,
  StreamEvent as StreamEventSchema,
  SubagentFleetControlOutcome,
  SubagentFleetSnapshot,
  Message as MessageSchema,
  Session as SessionSchema,
  Project as ProjectSchema,
  RemotePublishPrepared as RemotePublishPreparedSchema,
  ProviderConnectionError,
  type AgentEndpointId,
  type ProviderConnectionId,
  piEndpointId,
  providerConnectionIdForPiEndpoint,
  AgentResourceRpcError,
  WEB_SEARCH_CONFIG_DEFAULT,
  type WebSearchConfig,
  type McpConfigEntry,
  WebSearchError,
} from "@jingler/core";
import type {
  BrowserBounds,
  AdversarialReview,
  AgentModelSelection,
  StreamEvent,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  IssueAutomations,
  Message,
  PermissionMode,
  PluginCatalog,
  LoadedPlugin,
  PluginSettingValue,
  PluginSettingsSnapshot,
  SettingContribution,
  PrMergeMethod,
  PublishCheckpoint,
  Project,
  ReviewComment,
  ReviewSubmitKind,
  ReasoningSetting,
  Session,
  GitHubAppConnectionStatus,
  GitHubSessionRoute,
  GitHubRelayDelivery,
  GitHubRelayStreamMessage,
  GitHubRelayEvent,
  GitHubFeedbackClaimStatus,
  Environment,
  SettledSessionStatus,
  WorkspaceTransferCheckpoint,
} from "@jingler/core";
import type { GitHubRepository, } from "@jingler/cli-adapters";
import {
  AssetListRpcs,
  JinglerCoreRpcs,
  JinglerReviewRpcs,
  JinglerRpcs,
  isLanguageHoverPath,
  SessionDiffStat,
  SessionFileDiff,
  SessionReviewDiff,
  type SessionCreationPhase,
  type SessionCreationUpdate,
} from "@jingler/contracts";
import { FileSystem, Path } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform";
import { RpcServer } from "@effect/rpc";
import type {
  FromClientEncoded,
  FromServerEncoded,
} from "@effect/rpc/RpcMessage";
import {
  Duration,
  Effect,
  Layer,
  Mailbox,
  Option,
  Runtime,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { WebContents } from "electron";
import { BrowserWindow, ipcMain, shell } from "electron";
import { showNotification, shouldNotify } from "./notifications.js";
import { PreviewViewService } from "./preview-view.js";
import { DialogService } from "./dialog.js";
import { primeOffloadSessions } from "./offload-session-primer.js";
import {
  firePageGone,
  interruptOnPageGone,
} from "./web-contents-lifecycle.js";
import {
  dialGitHubRelay,
  GitHubRelayConnection,
  GitHubRelaySupervisor,
  installationCanRouteRepository,
  refreshGitHubRelaySupervisors,
} from "./github-relay.js";

/** The single IPC channel both directions of the RPC transport ride on. */
export const authenticatedSession = () => AuthService.getSession().pipe(Effect.tap(session => RoutinesService.pipe(Effect.flatMap(service => session ? service.start : service.stop), Effect.catchAll(cause => Effect.logError(cause.message)))))

export const RPC_CHANNEL = "jingler/rpc";

/**
 * `Config.get` handler. A malformed or absent config folds to `null` so the
 * renderer treats it as "not configured yet" and shows first-run setup, rather
 * than surfacing a read error. Exported so its folding behaviour is unit-tested.
 */
export const configGet = () =>
  ConfigService.get().pipe(Effect.orElseSucceed(() => null));

const githubConnectionError = (error: GitHubApiError): AuthError =>
  new AuthError({ message: error.message });

interface PendingRelayAcknowledgement {
  readonly resolve: () => void;
  readonly reject: (cause: Error) => void;
}

const pendingRelayAcknowledgements = new Map<
  string,
  PendingRelayAcknowledgement
>();
const relayAcknowledgementKey = (clientId: string, cursor: number): string =>
  `${clientId}:${cursor}`;

export const githubAckEvent = (
  clientId: string,
  cursor: number,
  outcome?: "routed" | "retry",
): Effect.Effect<void> =>
  Effect.sync(() => {
    const key = relayAcknowledgementKey(clientId, cursor);
    const pending = pendingRelayAcknowledgements.get(key);
    if (!pending) return;
    pendingRelayAcknowledgements.delete(key);
    if (outcome === "retry") {
      // A negative acknowledgement: the renderer could not route this frame.
      // Rejecting fails the connection's serial delivery, which closes the
      // socket and replays the frame with backoff — instead of holding the
      // cursor (and every frame behind it) hostage forever.
      pending.reject(
        new Error("The renderer asked for this GitHub delivery to be replayed"),
      );
      return;
    }
    pending.resolve();
  });

const githubConnectionWithCli = (
  appStatus: Effect.Effect<GitHubAppConnectionStatus, GitHubApiError, GitHubAuth>,
): Effect.Effect<
  GitHubAppConnectionStatus,
  AuthError,
  GitHubAuth | GitHubApi | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const cliAvailable = yield* GitHubApi.cliAvailable().pipe(
      Effect.mapError(githubConnectionError),
    );
    const status = yield* appStatus.pipe(
      Effect.mapError(githubConnectionError),
      Effect.catchAll((error) =>
        cliAvailable
          ? Effect.succeed({
              enabled: false,
              connected: false,
              user: null,
              installations: [],
              lastRefreshedAt: null,
            })
          : Effect.fail(error),
      ),
    );
    return { ...status, cliAvailable };
  });

export const githubConnectionStatus = () =>
  githubConnectionWithCli(GitHubAuth.status());

export const githubRepositories = () =>
  GitHubApi.repositories().pipe(Effect.mapError(githubConnectionError));

export const githubConnectionRefresh = () =>
  githubConnectionWithCli(GitHubAuth.refresh());

export const githubConnectionInstall = (): Effect.Effect<
  string,
  AuthError,
  GitHubAuth
> =>
  GitHubAuth.install(process.env.JINGLER_DEV_AUTH_LOOPBACK).pipe(
    Effect.mapError(githubConnectionError),
  );

export const githubConnectionDisconnect = (): Effect.Effect<
  void,
  AuthError,
  GitHubAuth
> => GitHubAuth.disconnect().pipe(Effect.mapError(githubConnectionError));

/**
 * `Setup.chooseReposDir` handler. Opens the native picker; a cancelled dialog (or
 * any failure) folds to `null`, otherwise the chosen dir is persisted and the new
 * config returned. Exported so the cancel/persist branches are unit-tested.
 */
export const chooseReposDir = () =>
  Effect.gen(function* () {
    const dialog = yield* DialogService;
    const dir = yield* dialog.chooseDirectory();
    if (dir === null) return null;
    return yield* ConfigService.setReposDir(dir);
  }).pipe(Effect.orElseSucceed(() => null));



/** Product-owned skills plus enabled managed skills and prompts. */
export const skillsList = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId).pipe(
      Effect.orElseSucceed(() => null),
    );
    const service = yield* AgentResourceService;
    const resources = yield* service
      .enabledForTarget(session?.environmentId ?? "desktop")
      .pipe(Effect.orElseSucceed(() => []));
    const managed = resources.flatMap((resource) =>
      BUILTIN_SKILLS.some(({ name }) => name === `/${resource.id}`)
        ? []
        : [
            {
              name: `/${resource.id}`,
              description: resource.description,
              source:
                resource.kind === "skill"
                  ? ("skill" as const)
                  : ("command" as const),
            },
          ],
    );
    return [...BUILTIN_SKILLS, ...managed];
  });

// ── MCP servers — ~/jingler/mcp.json ─────────────────────────────────────────

const mcpError = (message: string, cause?: unknown) =>
  new ConfigError({ message, cause });

/** Known source configs; re-read on every call so imports never go stale. */
const mcpImportHome = (): string =>
  process.env.JINGLER_E2E === "1" && process.env.JINGLER_HOME
    ? process.env.JINGLER_HOME
    : homedir();

const mcpImportSources: Record<
  "claude" | "codex" | "opencode",
  { readonly path: () => string; readonly parse: (raw: string) => ReadonlyArray<McpImportCandidate> }
> = {
  claude: { path: () => resolve(mcpImportHome(), ".claude.json"), parse: parseClaudeMcp },
  codex: { path: () => resolve(mcpImportHome(), ".codex", "config.toml"), parse: parseCodexMcp },
  opencode: {
    path: () => resolve(mcpImportHome(), ".config", "opencode", "opencode.json"),
    parse: parseOpencodeMcp,
  },
};

/** Parse one source file into full (secret-bearing) candidates. Main-only. */
const mcpImportParse = (source: "claude" | "codex" | "opencode") =>
  Effect.tryPromise({
    try: () => readFile(mcpImportSources[source].path(), "utf8"),
    catch: () =>
      mcpError(`No ${source} config found at ${mcpImportSources[source].path()}`),
  }).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => mcpImportSources[source].parse(raw),
        catch: (cause) => mcpError(`Could not parse the ${source} config`, cause),
      }),
    ),
  );

const mcpCandidateTarget = (candidate: McpImportCandidate): string =>
  candidate.entry === null
    ? ""
    : candidate.entry.type === "remote"
      ? candidate.entry.url
      : candidate.entry.command.join(" ");

const mcpList = () =>
  Effect.gen(function* () {
    const secretStore = yield* SecretStore;
    return yield* McpConfigService.listAuthenticated(secretStore).pipe(
      Effect.map((servers) => ({ servers, error: null })),
      Effect.catchAll((cause) =>
        Effect.succeed({ servers: [], error: cause.message }),
      ),
    );
  });

const mcpStatus = () =>
  Effect.gen(function* () {
    const secretStore = yield* SecretStore;
    const entries = yield* McpConfigService.parsedAuthenticated(secretStore).pipe(
      Effect.mapError((cause) => mcpError(cause.message, cause)),
    );
    return yield* probeAll(entries, null, () => new Date().toISOString());
  });

const mcpEntry = (name: string) =>
  McpConfigService.parsed().pipe(
    Effect.mapError((cause) => mcpError(cause.message, cause)),
    Effect.flatMap((entries) => {
      const entry = entries.find((candidate) => candidate.server.name === name);
      return entry === undefined
        ? Effect.fail(mcpError(`MCP server "${name}" does not exist`))
        : Effect.succeed(entry);
    }),
  );

const mcpSetApiKey = (name: string, apiKey: string) =>
  Effect.gen(function* () {
    const entry = yield* mcpEntry(name);
    if (entry.server.authKind !== "api-key") {
      return yield* Effect.fail(mcpError(`MCP server "${name}" does not use API-key authentication`));
    }
    if (entry.credentialIdentity === undefined) {
      return yield* Effect.fail(mcpError(`MCP server "${name}" has no credential identity`));
    }
    const secretStore = yield* SecretStore;
    yield* new McpAuthStore(secretStore).write(name, {
      type: "api-key",
      identity: entry.credentialIdentity,
      apiKey,
    });
  });

const mcpStartAuthorization = (name: string) =>
  Effect.gen(function* () {
    const entry = yield* mcpEntry(name);
    const secretStore = yield* SecretStore;
    const authorizationUrl = yield* startMcpOAuthAuthorization(entry, secretStore).pipe(
      Effect.mapError((cause) => mcpError(cause.message, cause)),
    );
    return { authorizationUrl, state: "authorizing" as const };
  });

const mcpApplyImport = (
  source: "claude" | "codex" | "opencode",
  names: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const requested = new Set(names);
    const candidates = yield* mcpImportParse(source);
    const existing = new Set(
      (yield* mcpList()).servers.map((server) => server.name),
    );
    const selected = candidates.filter(
      (candidate): candidate is McpImportCandidate & { entry: McpConfigEntry } =>
        requested.has(candidate.name) && candidate.entry !== null && !existing.has(candidate.name),
    );
    yield* McpConfigService.writeAll(
      Object.fromEntries(selected.map((candidate) => [candidate.name, candidate.entry])),
    ).pipe(Effect.mapError((cause) => mcpError(cause.message, cause)));
    return selected.map((candidate) => candidate.name);
  });

const mcpReveal = () =>
  Effect.gen(function* () {
    const paths = yield* AppPaths;
    // Reveal needs a file to point at; seed the template on first use.
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(paths.mcpConfigFile), { recursive: true });
        try {
          await writeFile(
            paths.mcpConfigFile,
            `${JSON.stringify({ mcp: {} }, null, 2)}\n`,
            { flag: "wx", mode: 0o600 },
          );
        } catch (cause) {
          if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
        }
      },
      catch: (cause) => mcpError("Could not create mcp.json", cause),
    });
    yield* Effect.sync(() => shell.showItemInFolder(paths.mcpConfigFile));
  });

/**
 * `Sessions.diff` handler. Resolves the session's worktree and returns its
 * unified working diff (empty when there's no worktree or the tree is clean).
 * Git failures stay in the typed error channel so the renderer cannot mistake
 * a broken worktree for a clean one.
 * Exported for tests.
 */
export const sessionDiff = (id: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(id).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!session?.worktreePath) return EMPTY_REVIEW_DIFF;
    return yield* WorkspaceService.diff(session.worktreePath);
  });

export const sessionDiffStat = (id: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(id).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!session?.worktreePath) return { added: 0, removed: 0, files: 0 };
    return yield* WorkspaceService.diffStat(session.worktreePath);
  });

export const sessionFileDiff = (id: string, path: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(id).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!session?.worktreePath) return { kind: "patch" as const, patch: "" };
    return yield* WorkspaceService.boundedFileDiff(session.worktreePath, path);
  });

/** Resolve a session (best-effort; unknown → null) for the GitHub handlers. */
const resolveSession = (sessionId: string) =>
  SessionStore.get(sessionId).pipe(Effect.orElseSucceed(() => null));

type SessionWithPr = Session & { readonly prNumber: number };

const hasActivePr = (session: Session | null): session is SessionWithPr =>
  session !== null && session.prNumber !== null;

const resolvePiCreateInput = <Input extends {
  readonly runtimeId?: "pi" | "claude" | "codex" | "opencode"
  readonly endpointId?: AgentEndpointId
  readonly connectionId?: ProviderConnectionId
}>(input: Input): Effect.Effect<Input, ProviderConnectionError> => {
  if (input.connectionId !== undefined || input.runtimeId !== "pi") {
    return Effect.succeed(input)
  }
  if (input.endpointId === undefined) {
    return Effect.fail(new ProviderConnectionError({
      message: "PI session creation requires an endpoint"
    }))
  }
  const connectionId = providerConnectionIdForPiEndpoint(
    input.endpointId,
    "environmentId" in input && typeof input.environmentId === "string"
      ? input.environmentId
      : "desktop"
  )
  return connectionId === null
    ? Effect.fail(new ProviderConnectionError({
        message: "PI endpoint does not belong to the execution target"
      }))
    : Effect.succeed({ ...input, connectionId })
}

export const sessionCreationOptions = (
  input: {
    readonly modelId: CreateSessionInput["modelId"];
    readonly mode?: PermissionMode;
    readonly reasoning?: ReasoningSetting | null;
  },
  configuredDefault?: PermissionMode,
) => ({
  defaultMode: defaultModeFor(input.mode ?? configuredDefault),
  defaultReasoning: input.reasoning ?? undefined,
});

/** `Explanation.watch` handler, shared with the RPC integration test. */
export const explanationWatch = (sessionId: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (session === null || !session.worktreePath) return Stream.empty;
      const store = yield* ExplanationStore;
      return store.watch(session.worktreePath, session.id);
    }),
  );

/** Resolve a session only when it has an active pull request. */
const sessionWithPr = (sessionId: string) =>
  resolveSession(sessionId).pipe(
    Effect.map((session): SessionWithPr | null =>
      hasActivePr(session) ? session : null,
    ),
  );

/**
 * `Sessions.createFromPr` handler. Reads the git "share checked-out branches"
 * lever from config (default on) and passes it through, so a PR whose branch is
 * already checked out locally can be opened as a session when the user allows it.
 */
export const createSessionFromPr = (input: CreateSessionFromPrInput) =>
  Effect.gen(function* () {
    const config = yield* ConfigService.get().pipe(
      Effect.orElseSucceed(() => null),
    );
    const allowSharedCheckout = config?.git?.shareCheckedOutBranches ?? true;
    const runtimeInput = yield* resolvePiCreateInput(input).pipe(
      Effect.mapError((cause) => new GitError({ message: cause.message, cause }))
    )
    return yield* SessionStore.createFromPr(runtimeInput, {
      allowSharedCheckout,
      ...sessionCreationOptions(runtimeInput, config?.defaultMode),
    });
  });

/**
 * `Sessions.create` handler. Seeds the new session's permission mode + model
 * from the chosen CLI's configured provider defaults (Settings · Providers), so
 * a session opens in the mode/model the user picked. Absent config → the store
 * omits them and the harness applies its own defaults. Exported for tests.
 */
export const createSession = (input: CreateSessionInput) =>
  Effect.gen(function* () {
    const config = yield* ConfigService.get().pipe(
      Effect.orElseSucceed(() => null),
    );
    const resolvedInput =
      input.projectId === undefined
        ? input
        : yield* ProjectService.get(input.projectId).pipe(
            Effect.map((project) => ({
              ...input,
              repoPath: project.path,
              repoName: project.name,
              ...(project.environmentId === undefined
                ? {}
                : { environmentId: project.environmentId }),
            })),
          );
    if (resolvedInput.checkpointSafeMode && resolvedInput.projectId) {
      const project = yield* ProjectService.get(resolvedInput.projectId);
      if (project.workflow?.setup) return yield* Effect.fail(new GitError({ message: "Checkpoint-safe creation cannot run this project's setup shell command. Use a project without setup commands or create an ordinary workspace; models and permissions are unchanged." }));
    }
    const runtimeInput = yield* resolvePiCreateInput(resolvedInput).pipe(
      Effect.mapError((cause) => new GitError({ message: cause.message, cause }))
    )
    return yield* SessionStore.create(
      runtimeInput,
      sessionCreationOptions(runtimeInput, config?.defaultMode),
    );
  });

/** Provision on the selected device and mirror only the returned metadata locally. */
type SessionCreationProgress = (
  phase: SessionCreationPhase,
) => Effect.Effect<void>;

const reportSessionCreation = (
  progress: SessionCreationProgress | undefined,
  phase: SessionCreationPhase,
) => progress?.(phase) ?? Effect.void;

const sessionCreationStream = <E, R>(
  create: (progress: SessionCreationProgress) => Effect.Effect<Session, E, R>,
) =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox.make<SessionCreationUpdate, E>(16);
      yield* Effect.forkScoped(
        create((phase) =>
          Effect.sync(() => {
            mailbox.unsafeOffer({ kind: "progress", phase });
          }),
        ).pipe(
          Effect.tap((session) =>
            Effect.sync(() => {
              mailbox.unsafeOffer({ kind: "complete", session });
            }),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.sync(() => {
                const message =
                  typeof error === "object" &&
                  error !== null &&
                  "message" in error &&
                  typeof error.message === "string"
                    ? error.message
                    : "Session creation failed.";
                mailbox.unsafeOffer({ kind: "failed", message });
              }).pipe(Effect.zipRight(mailbox.end), Effect.asVoid),
            onSuccess: () => mailbox.end.pipe(Effect.asVoid),
          }),
        ),
      );
      return Mailbox.toStream(mailbox);
    }),
  );

const prepareLocalWorkspace = (session: Session) =>
  Effect.gen(function* () {
    const workflow = yield* WorkspaceWorkflowService;
    if (session.checkpointSafeMode) {
      yield* WorkspaceCheckpointService.setMode(session.id, true)
    } else yield* workflow.setup(session.id).pipe(Effect.either)
    return yield* SessionStore.get(session.id).pipe(
      Effect.mapError((cause) => new GitError({ message: "Created workspace could not be reloaded", cause })),
    )
  })

export const createSessionRouted = (
  input: CreateSessionInput,
  progress?: SessionCreationProgress,
) =>
  Effect.gen(function* () {
    const runtimeInput = yield* resolvePiCreateInput(input).pipe(
      Effect.mapError((cause) => new GitError({ message: cause.message, cause }))
    )
    if (runtimeInput.environmentId === undefined) {
      yield* reportSessionCreation(progress, "creating-session");
      const created = yield* createSession(runtimeInput);
      const session = yield* prepareLocalWorkspace(created);
      const initialPrompt = runtimeInput.initialPrompt?.trim();
      if (!initialPrompt || session.workspaceLifecycle?.status === "setup-failed") {
        yield* reportSessionCreation(progress, "ready");
        return session;
      }
      const runtime = yield* AgentRuntime;
      const named = yield* retitleCreatedSessionFromPrompt(
        session,
        initialPrompt,
        makeAgentRuntimeTitleGenerator(runtime),
      );
      yield* reportSessionCreation(progress, "ready");
      return named;
    }

    yield* reportSessionCreation(progress, "checking-access");
    const environmentService = yield* EnvironmentService;
    const environment = yield* environmentService
      .environment(runtimeInput.environmentId)
      .pipe(
        Effect.mapError(
          (cause) => new GitError({ message: cause.message, cause }),
        ),
      );
    return yield* provisionRemoteSession(
      runtimeInput.environmentId,
      "Sessions.create",
      runtimeInput,
      progress,
      environment,
    );
  });

/**
 * `Sessions.createFromIssue` handler. Like `createSession` (fresh branch, same
 * provider-default seeding) but links the issue + automations and seeds the task
 * from the issue. Exported for tests.
 */
export const createSessionFromIssue = (input: CreateSessionFromIssueInput) =>
  Effect.gen(function* () {
    const config = yield* ConfigService.get().pipe(
      Effect.orElseSucceed(() => null),
    );
    const runtimeInput = yield* resolvePiCreateInput(input).pipe(
      Effect.mapError((cause) => new GitError({ message: cause.message, cause }))
    )
    return yield* SessionStore.createFromIssue(
      runtimeInput,
      sessionCreationOptions(runtimeInput, config?.defaultMode),
    );
  });

/** Resolve or clone one local project on an owned device during session startup. */
const githubSlugFromRemote = (url: string): string | undefined => {
  const repository = parseGitHubRemote(url);
  return repository === null ? undefined : `${repository.owner}/${repository.repo}`;
};

const ensureProjectOnOwnedEnvironment = (
  project: Project,
  environmentId: string,
) => Effect.gen(function* () {
  const url = yield* GitService.remoteUrl(project.path).pipe(
    Effect.flatMap((value) =>
      value === null
        ? Effect.fail(new GitError({ message: `${project.name} has no origin remote to clone.` }))
        : Effect.succeed(value)
    )
  )
  return yield* RemoteSessionService.requestOnEnvironment(
    environmentId,
    "Projects.ensure",
    { url, name: project.name },
  ).pipe(
    Effect.timeoutFail({
      duration: "60 seconds",
      onTimeout: () => new GitError({
        message: `Timed out preparing ${project.name} on ${environmentId}. Check that the device is online and its Git credentials can access the origin.`
      })
    }),
    Effect.flatMap(Schema.decodeUnknown(ProjectSchema)),
    Effect.map((remoteProject) => ({
      ...remoteProject,
      environmentId,
      githubSlug: githubSlugFromRemote(url),
    })),
    Effect.mapError((cause) =>
      cause instanceof GitError
        ? cause
        : new GitError({ message: `Could not prepare ${project.name} on the selected host`, cause })
    )
  )
})

const decodeRemoteSession = (value: unknown, environmentId: string) =>
  Schema.decodeUnknown(SessionSchema)(value).pipe(
    Effect.mapError((cause) => new GitError({ message: "The remote device returned invalid session metadata", cause })),
    Effect.flatMap((session) => session.environmentId === environmentId
      ? Effect.succeed(session)
      : Effect.fail(new GitError({ message: "The remote device returned a session for a different environment" })))
  )

const provisionRemoteSession = (
  environmentId: string,
  operation:
    "Sessions.create" | "Sessions.createFromPr" | "Sessions.createFromIssue",
  input:
    CreateSessionInput | CreateSessionFromPrInput | CreateSessionFromIssueInput,
  progress?: SessionCreationProgress,
  knownEnvironment?: Environment,
) => {
  let managedSessionId: string | undefined;
  return Effect.gen(function* () {
    const remote = yield* RemoteSessionService;
    const sessions = yield* SessionStore;
    const environmentService = yield* EnvironmentService;
    const environment =
      knownEnvironment ??
      (yield* environmentService
        .environment(environmentId)
        .pipe(
          Effect.mapError(
            (cause) => new GitError({ message: cause.message, cause }),
          ),
        ));
    let requestSession = {
      id: "",
      environmentId,
      connectionId: input.connectionId,
      providerId: input.providerId,
      modelId: input.modelId,
    };
    let requestInput = input;
    if (environment.kind === "owned" && input.projectId !== undefined) {
      yield* reportSessionCreation(progress, "resolving-repository");
      const localProject = yield* ProjectService.get(input.projectId);
      const remoteProject = yield* ensureProjectOnOwnedEnvironment(
        localProject,
        environmentId,
      );
      requestInput = {
        ...input,
        projectId: remoteProject.id,
        repoPath: remoteProject.path,
        repoName: remoteProject.name,
        githubSlug: remoteProject.githubSlug,
      };
    } else if (environment.kind === "managed") {
      if (!environmentRuntimeIsCurrent(environment)) {
        return yield* Effect.fail(
          new GitError({
            message:
              "Cloud is running an incompatible agent runtime. Update Cloud before starting this pi session.",
          }),
        );
      }
      yield* reportSessionCreation(progress, "resolving-repository");
      const sessionId = `s_cloud_${randomBytes(18).toString("base64url")}`;
      managedSessionId = sessionId;
      const repository = yield* managedRepositoryIdentity(input.repoPath);
      const { branch, baseBranch, source } = remoteProvisioningSource(operation, input);
      const headSha = yield* GitService.revision(input.repoPath, branch).pipe(
        Effect.orElse(() =>
          GitService.revision(input.repoPath, `origin/${branch}`),
        ),
      );
      const plan = createWorkspaceProvisioningPlan({
        githubSlug: `${repository.owner}/${repository.repo}`,
        headSha,
        branch,
        baseBranch,
        createBranch: false,
        source,
      });
      yield* reportSessionCreation(progress, "starting-sandbox");
      if (input.connectionId === undefined) {
        return yield* Effect.fail(new GitError({
          message: "This managed environment requires a PI provider connection"
        }))
      }
      yield* environmentService
        .hydrateManagedWorkspace(environment, sessionId, plan, {
          connectionId: input.connectionId,
          providerId: input.providerId,
          modelId: input.modelId,
        })
        .pipe(
          Effect.mapError(
            (cause) => new GitError({ message: cause.message, cause }),
          ),
        );
      requestSession = {
        id: sessionId,
        environmentId,
        connectionId: input.connectionId,
        providerId: input.providerId,
        modelId: input.modelId,
      };
      requestInput = {
        ...input,
        requestedSessionId: sessionId,
        repoPath: "/workspace",
        githubSlug: `${repository.owner}/${repository.repo}`,
      };
    }
    yield* reportSessionCreation(progress, "creating-session");
    const value = yield* (
      environment.kind === "managed"
        ? remote.request(requestSession, operation, requestInput)
        : remote.requestOnEnvironment(environmentId, operation, requestInput)
    ).pipe(
      Effect.mapError(
        (cause) => new GitError({ message: cause.message, cause }),
      ),
    );
    const created = yield* decodeRemoteSession(value, environmentId);
    const persisted = yield* sessions.upsertRemote(created);
    yield* reportSessionCreation(progress, "ready");
    return persisted;
  }).pipe(
    Effect.onError(() =>
      Effect.gen(function* () {
        if (managedSessionId === undefined) return;
        const environments = yield* EnvironmentService;
        const environment = yield* environments
          .environment(environmentId)
          .pipe(Effect.orElseSucceed(() => null));
        if (environment?.kind !== "managed") return;
        yield* environments
          .cleanupManagedSession(environment, managedSessionId)
          .pipe(Effect.ignore);
      }),
    ),
  );
};

export const createSessionFromPrRouted = (
  input: CreateSessionFromPrInput,
  progress?: SessionCreationProgress,
) =>
  Effect.gen(function* () {
    const runtimeInput = yield* resolvePiCreateInput(input).pipe(
      Effect.mapError((cause) => new GitError({ message: cause.message, cause }))
    )
    if (runtimeInput.environmentId === undefined) {
      yield* reportSessionCreation(progress, "creating-session");
      const session = yield* createSessionFromPr(runtimeInput);
      const prepared = yield* prepareLocalWorkspace(session);
      yield* reportSessionCreation(progress, "ready");
      return prepared;
    }
    yield* reportSessionCreation(progress, "checking-access");
    return yield* provisionRemoteSession(
      runtimeInput.environmentId,
      "Sessions.createFromPr",
      runtimeInput,
      progress,
    );
  });

export const createSessionFromIssueRouted = (
  input: CreateSessionFromIssueInput,
  progress?: SessionCreationProgress,
) =>
  Effect.gen(function* () {
    const runtimeInput = yield* resolvePiCreateInput(input).pipe(
      Effect.mapError((cause) => new GitError({ message: cause.message, cause }))
    )
    if (runtimeInput.environmentId === undefined) {
      yield* reportSessionCreation(progress, "creating-session");
      const session = yield* createSessionFromIssue(runtimeInput);
      const prepared = yield* prepareLocalWorkspace(session);
      yield* reportSessionCreation(progress, "ready");
      return prepared;
    }
    yield* reportSessionCreation(progress, "checking-access");
    return yield* provisionRemoteSession(
      runtimeInput.environmentId,
      "Sessions.createFromIssue",
      runtimeInput,
      progress,
    );
  });

export const setEnvironment = (
  sessionId: string,
  environmentId: string | undefined,
) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore;
    const environments = yield* EnvironmentService;
    const session = yield* sessions.get(sessionId);
    // The persisted Session counters lag a running turn. The transcript is the
    // durable proof that this checkout has started work, so never move it in
    // place merely because the first streamed usage/diff update has not landed.
    const hasTranscript = yield* TranscriptStore.list(
      session.activeChatId,
    ).pipe(
      Effect.map((messages) => messages.length > 0),
      Effect.orElseSucceed(() => true),
    );
    return yield* setSessionEnvironment(
      session,
      environmentId,
      {
        environments: () => environments.list,
        persist: (id, target) => sessions.setEnvironment(id, target),
        continueSession: (source, target) =>
          Effect.fail(
            new EnvironmentHandoffError({
              reason: "unavailable",
              message:
                "The target device did not admit a continuation workspace.",
              sessionId: source.id,
              ...(target === undefined ? {} : { environmentId: target }),
            }),
          ),
      },
      hasTranscript,
    );
  });

interface ContinuationRepository {
  readonly name: string;
  readonly path: string;
  readonly defaultBranch: string | null;
  readonly githubSlug: string | null;
}

/** Match repository identity across machines without ever reusing an absolute path. */
export const selectContinuationRepository = (
  source: Pick<ContinuationRepository, "name" | "githubSlug">,
  candidates: ReadonlyArray<ContinuationRepository>,
): ContinuationRepository | null => {
  const slug = source.githubSlug?.toLocaleLowerCase();
  if (slug) {
    const bySlug = candidates.find(
      (candidate) => candidate.githubSlug?.toLocaleLowerCase() === slug,
    );
    if (bySlug) return bySlug;
  }
  const name = source.name.toLocaleLowerCase();
  return (
    candidates.find(
      (candidate) => candidate.name.toLocaleLowerCase() === name,
    ) ?? null
  );
};

const continuationRepositories = (
  environments: EnvironmentService,
  environmentId: string | undefined,
) =>
  Effect.gen(function* () {
    if (environmentId === undefined) {
      const repositories = yield* WorkspaceService.listRepos();
      return repositories satisfies ReadonlyArray<ContinuationRepository>;
    }
    const result = yield* environments.discovery(environmentId);
    return (result.discovery?.repositories ??
      []) satisfies ReadonlyArray<ContinuationRepository>;
  });

export const continueOnEnvironment = (
  sessionId: string,
  environmentId: string | undefined,
) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore;
    const environments = yield* EnvironmentService;
    const remote = yield* RemoteSessionService;
    const session = yield* sessions.get(sessionId);
    return yield* continueSessionOnEnvironment(session, environmentId, {
      environments: () => environments.list,
      persist: (id, target) => sessions.setEnvironment(id, target),
      continueSession: (source, target) =>
        continueWorkspace(source, target, environments, remote),
    });
  });

/**
 * Read the branch a direct session's shared checkout is currently on — the live
 * branch a `BranchDrift` recovery acts against. Fails when the session has no
 * checkout or sits on a detached HEAD (no named branch to adopt or fork).
 */
const driftedLiveBranch = (session: Session) =>
  Effect.gen(function* () {
    const checkoutPath = session.worktreePath ?? session.repoPath;
    if (!checkoutPath) {
      return yield* Effect.fail(
        new GitError({
          message: "This session has no checkout to read a branch from.",
        }),
      );
    }
    const liveBranch = yield* branchAt(checkoutPath);
    if (liveBranch === null) {
      return yield* Effect.fail(
        new GitError({
          message:
            "The checkout is on a detached HEAD; check out a named branch before recovering.",
        }),
      );
    }
    return { checkoutPath, liveBranch };
  });

/**
 * `Sessions.adoptBranch` — re-point a drifted direct session at the branch its
 * shared checkout is now on. The operator chose to keep working there, so the
 * session's pin follows the checkout. A no-op (returns the session unchanged) if
 * the checkout never actually drifted.
 */
export const adoptBranch = (sessionId: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore;
    const session = yield* sessions.get(sessionId);
    if (workspaceModeOf(session) !== "direct") {
      return yield* Effect.fail(
        new GitError({
          message: "Only a direct session can adopt its checkout's branch.",
        }),
      );
    }
    const { liveBranch } = yield* driftedLiveBranch(session);
    if (liveBranch === session.branch) return session;
    yield* sessions.setBranch(sessionId, liveBranch);
    return yield* sessions.get(sessionId);
  });

/**
 * `Sessions.forkOntoBranch` — hand a drifted direct session's work off to a
 * fresh, isolated worktree session forked from the branch the checkout is now
 * on, carrying the transcript and the uncommitted changes. The source session
 * stays pinned to its original branch, so the developer can switch their primary
 * checkout back and it unfreezes.
 */
/**
 * Validate a `forkOntoBranch` request and return the settled inputs a clean
 * worktree fork needs. Fails (GitError) when the session is not a drifted direct
 * session, or is missing a provider connection or a repository.
 */
const forkInputs = (source: Session) =>
  Effect.gen(function* () {
    if (workspaceModeOf(source) !== "direct") {
      return yield* Effect.fail(
        new GitError({
          message:
            "Only a direct session can fork its drifted branch into a worktree.",
        }),
      );
    }
    const { liveBranch } = yield* driftedLiveBranch(source);
    if (liveBranch === source.branch) {
      return yield* Effect.fail(
        new GitError({
          message: "The checkout has not drifted; there is nothing to fork.",
        }),
      );
    }
    if (
      source.connectionId === undefined ||
      source.providerId === undefined ||
      source.modelId === undefined
    ) {
      return yield* Effect.fail(
        new GitError({
          message: "Choose a provider connection before forking this session.",
        }),
      );
    }
    if (!source.repoPath) {
      return yield* Effect.fail(
        new GitError({ message: "This session has no repository to fork from." }),
      );
    }
    return {
      liveBranch,
      repoPath: source.repoPath,
      connectionId: source.connectionId,
      providerId: source.providerId,
      modelId: source.modelId,
    };
  });

export const forkOntoBranch = (sessionId: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore;
    const source = yield* sessions.get(sessionId);
    const { liveBranch, repoPath, connectionId, providerId, modelId } =
      yield* forkInputs(source);
    const sourceMessages = yield* TranscriptStore.list(source.activeChatId).pipe(
      Effect.orElseSucceed(() => []),
    );
    // A fresh, CLEAN worktree forked from the drifted branch's committed tip —
    // deliberately NOT a working-tree handoff. The shared checkout that drifted
    // usually carries the developer's own uncommitted changes (the ones that
    // rode along when the agent ran `git switch -c`); dragging that dirty tree
    // into the fork is exactly what makes the fork "look like main". The fork
    // keeps the branch's committed history and the conversation; the agent
    // re-derives its edits from that context in a clean tree.
    const created = yield* createSession({
      repoPath,
      repoName: source.repo,
      connectionId,
      providerId,
      modelId,
      baseBranch: liveBranch,
      title: `${source.title} (fork)`,
    }).pipe(
      Effect.mapError(
        () =>
          new GitError({
            message: "The desktop could not provision the fork workspace.",
          }),
      ),
    );
    if (!created.worktreePath) {
      return yield* Effect.fail(
        new GitError({ message: "The fork has no verified workspace." }),
      );
    }
    // Carry the conversation for context, but NEVER the drift banner that led
    // here (see `transcriptForFork`).
    for (const message of transcriptForFork(sourceMessages)) {
      yield* TranscriptStore.append(created.activeChatId, message);
    }
    return created;
  });

/**
 * The source transcript a fork should inherit: the whole conversation MINUS the
 * `BranchDrift` banner that led to the fork.
 *
 * The source session's last turn ends in a `BranchDrift` part. Replaying it into
 * the fork would open the fork on a stale "checkout moved" banner offering to
 * fork again — the exact dead-end this recovery exists to end. The tool calls
 * that preceded it (the real work) are kept; a message left empty by the strip
 * is dropped so the fork does not open on a blank turn.
 */
export const transcriptForFork = (
  messages: ReadonlyArray<Message>,
): ReadonlyArray<Message> =>
  messages
    .map((message) => ({
      ...message,
      parts: message.parts.filter((part) => part._tag !== "BranchDrift"),
    }))
    .filter((message) => message.parts.length > 0);

/** A remote cleanup failure must not strand the desktop's local mirror forever. */
export const removeRemoteSessionMirror = <A, E1, R1, E2, R2>(
  removeRemote: Effect.Effect<A, E1, R1>,
  forgetLocal: Effect.Effect<void, E2, R2>,
) => removeRemote.pipe(Effect.ignore, Effect.zipRight(forgetLocal));

/** `Sessions.linkIssue` handler — attach a provider-neutral issue to a live session. */
export const linkIssue = (input: {
  sessionId: string;
  issue: IssueReference;
  automations?: IssueAutomations;
}) =>
  Effect.gen(function* () {
    yield* SessionStore.setIssue(input.sessionId, {
      reference: {
        providerId: input.issue.providerId,
        id: input.issue.id,
        ...(input.issue.providerAccountId === undefined
          ? {}
          : { providerAccountId: input.issue.providerAccountId }),
        identifier: input.issue.identifier,
        url: input.issue.url,
        title: input.issue.title,
        labels: input.issue.labels,
      },
      automations: input.automations,
    });
    return yield* SessionStore.get(input.sessionId);
  });

/** `Sessions.addIssues` handler — add/refresh links and select the last issue. */
export const addIssues = (input: {
  sessionId: string;
  issues: ReadonlyArray<IssueReference>;
}) =>
  Effect.gen(function* () {
    yield* SessionStore.addIssues(input.sessionId, input.issues);
    return yield* SessionStore.get(input.sessionId);
  });

/** `Sessions.selectIssue` handler — select one existing provider-scoped link. */
export const selectIssue = (sessionId: string, issue: IssueIdentity) =>
  Effect.gen(function* () {
    yield* SessionStore.selectIssue(sessionId, issue);
    return yield* SessionStore.get(sessionId);
  });

/** `Sessions.removeIssue` handler — remove one link and preserve the rest. */
export const removeIssue = (sessionId: string, issue: IssueIdentity) =>
  Effect.gen(function* () {
    yield* SessionStore.removeIssue(sessionId, issue);
    return yield* SessionStore.get(sessionId);
  });

/** `Sessions.unlinkIssue` handler — detach every linked issue. */
export const unlinkIssue = (sessionId: string) =>
  Effect.gen(function* () {
    yield* SessionStore.setIssue(sessionId, null);
    return yield* SessionStore.get(sessionId);
  });

/**
 * `Github.closeIssue` handler — close the session's linked issue (close-on-merge).
 * Fails with `GitHubApiError` when there's no worktree or linked issue.
 */
export const githubCloseIssue = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId);
    const issue = session ? issueReferenceForProvider(session, "github") : undefined;
    const issueNumber = issue ? Number(issue.id) : Number.NaN;
    if (
      !(session?.worktreePath && Number.isSafeInteger(issueNumber)) ||
      issueNumber <= 0
    ) {
      return yield* Effect.fail(
        new GitHubApiError({
          reason: "validation",
          message: "No linked issue to close",
        }),
      );
    }
    yield* GitHubApi.closeIssue(session.worktreePath, issueNumber);
  });

/** `Github.issue` handler — the full linked-issue view model for the Issue tab. */
export const githubIssue = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId);
    const issue = session ? issueReferenceForProvider(session, "github") : undefined;
    const issueNumber = issue ? Number(issue.id) : Number.NaN;
    if (
      !(session?.worktreePath && Number.isSafeInteger(issueNumber)) ||
      issueNumber <= 0
    )
      return null;
    return yield* GitHubApi.issueView(session.worktreePath, issueNumber);
  });

/**
 * Resolve a session's worktree for the `Asset.*` handlers, or fail.
 *
 * Deliberately NOT best-effort like `resolveSession`: an asset read that can't
 * find a worktree must not silently fall back to anything — the worktree root
 * IS the sandbox, so "no worktree" has to stop the read rather than widen it.
 */
const assetWorktree = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId).pipe(
      Effect.catchAll(() => new SessionNotFoundError({ sessionId })),
    );
    if (!session.worktreePath)
      return yield* new SessionNotFoundError({ sessionId });
    return session.worktreePath;
  });

/** `Asset.list` handler — repository files scoped to the session worktree. */
export const assetList = (input: { sessionId: string }) =>
  Effect.flatMap(assetWorktree(input.sessionId), (worktree) =>
    AssetService.list(worktree),
  );

/** `Asset.read` handler — one asset's contents, sandboxed to the session worktree. */
export const assetRead = (input: { sessionId: string; path: string }) =>
  Effect.flatMap(assetWorktree(input.sessionId), (worktree) =>
    AssetService.read(worktree, input.path),
  );

/** `Asset.hover` handler — semantic hover scoped to one validated worktree file. */
export const assetHover = (input: {
  sessionId: string;
  path: string;
  symbol: string;
  line: number;
  column: number;
  text?: string;
}) =>
  Effect.gen(function* () {
    const worktree = yield* assetWorktree(input.sessionId);
    const payload = yield* AssetService.read(worktree, input.path);
    if (!("text" in payload) || !isLanguageHoverPath(input.path)) {
      return yield* new AssetUnsupportedError({ path: input.path });
    }
    return yield* Effect.tryPromise({
      try: (signal) => languageHover(
        worktree,
        input.path,
        input.symbol,
        input.line,
        input.column,
        input.text ?? payload.text,
        signal
      ),
      catch: (cause) => cause
    }).pipe(
      Effect.map((result) => result === null ? null : ({
        engine: result.engine,
        type: result.value.type,
        ...(result.value.documentation === undefined ? {} : { documentation: result.value.documentation })
      })),
      Effect.catchAll((cause) => Effect.succeed({
        unavailable: cause instanceof Error ? cause.message : String(cause)
      }))
    );
  });

/** `Asset.write` handler — revision-guarded replacement in the session worktree. */
export const assetWrite = (input: {
  sessionId: string;
  path: string;
  text: string;
  expectedRevision: string;
}) =>
  Effect.flatMap(resolveSession(input.sessionId), (session) => session?.checkpointSafeMode
    ? Effect.fail(new AssetWriteIoError({ path: input.path, message: "Use managed Pi structured file tools in checkpoint-safe mode; direct editor mutations are unsupported." }))
    : Effect.flatMap(assetWorktree(input.sessionId), (worktree) =>
    AssetService.write(
      worktree,
      input.path,
      input.text,
      input.expectedRevision,
    ),
  ));

/**
 * `Asset.reveal` handler — show the file in the OS file manager.
 *
 * The path is re-resolved through `AssetService` rather than taken from the
 * renderer's `absolutePath`, so revealing is held to the same containment rule
 * as reading. A renderer holding a stale or doctored payload can't use this to
 * point Finder at an arbitrary file.
 */
export const assetReveal = (input: { sessionId: string; path: string }) =>
  Effect.gen(function* () {
    const worktree = yield* assetWorktree(input.sessionId);
    const absolutePath = yield* AssetService.revealPath(worktree, input.path);
    yield* Effect.sync(() => shell.showItemInFolder(absolutePath));
  });

/**
 * `Asset.openPdf` handler — park Chromium's PDF viewer over the dock's rect.
 *
 * The absolute path is derived HERE, from the session's own worktree, rather
 * than accepted from the renderer. That keeps one containment check for both
 * doors into the filesystem: a renderer that could pass its own path would make
 * the native viewer a way around the check that guards `Asset.read`.
 */
export const assetOpenPdf = (input: {
  sessionId: string;
  path: string;
  bounds: BrowserBounds;
}) =>
  Effect.gen(function* () {
    const worktree = yield* assetWorktree(input.sessionId);
    const absolutePath = yield* AssetService.pdfPath(worktree, input.path);
    yield* Effect.flatMap(PreviewViewService, (v) =>
      v.openFile(input.sessionId, absolutePath, input.bounds),
    );
  });

/**
 * `Workspace.revertFile` handler — discard all uncommitted changes to `path` in
 * the session's worktree. A no-op for an unknown / worktree-less session.
 */
export const workspaceRevertFile = (input: {
  sessionId: string;
  path: string;
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId);
    if (!session?.worktreePath) return;
    if (session.checkpointSafeMode) return yield* Effect.fail(new GitError({ message: "Direct Git mutations are unsupported in checkpoint-safe mode. Use the checkpoint restore preview." }));
    if (workspaceModeOf(session) === "direct") {
      return yield* Effect.fail(
        new GitError({
          message:
            "Revert is disabled for direct sessions because this checkout may contain unrelated developer edits.",
        }),
      );
    }
    yield* WorkspaceService.revertFile(session.worktreePath, input.path);
  });

/**
 * `Workspace.revertLines` handler — revert just the uncommitted changes in a
 * line range of `path` in the session's worktree. No-op for an unknown session.
 */
export const workspaceRevertLines = (input: {
  sessionId: string;
  path: string;
  startLine: number;
  endLine: number;
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId);
    if (!session?.worktreePath) return;
    if (session.checkpointSafeMode) return yield* Effect.fail(new GitError({ message: "Direct Git mutations are unsupported in checkpoint-safe mode. Use the checkpoint restore preview." }));
    if (workspaceModeOf(session) === "direct") {
      return yield* Effect.fail(
        new GitError({
          message:
            "Revert is disabled for direct sessions because this checkout may contain unrelated developer edits.",
        }),
      );
    }
    yield* WorkspaceService.revertRange(
      session.worktreePath,
      input.path,
      input.startLine,
      input.endLine,
    );
  });

/**
 * `Github.pr` handler. Returns the linked PR via GitHub APIs or null when the
 * session has no worktree or no linked PR. Exported for tests.
 */
export const githubPrInbox = () => GitHubApi.inbox();

export const githubPrBySlug = (repository: string, number: number) =>
  GitHubApi.prViewBySlug(repository, number);

export const githubPr = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId);
    if (!session?.worktreePath || session.prNumber === null) return null;
    return yield* GitHubApi.prView(session.worktreePath, session.prNumber);
  });

/**
 * `Github.prState` handler — the lifecycle state of a session's linked PR (or
 * null when there's no worktree / linked PR). Drives the archive sweep. Exported
 * for tests.
 */
export const githubPrState = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId);
    if (!session?.worktreePath || session.prNumber === null) return null;
    return yield* GitHubApi.prState(session.worktreePath, session.prNumber);
  });

/**
 * `BackgroundTasks.output` handler — a settled task's transcript.
 *
 * Best-effort by design, matching every other read path in the app: a task whose
 * `output_file` is missing, unreadable, or not yet reported yields "" rather than
 * an error. The file is written by the harness and can be cleaned up underneath
 * us, and a failed read must not take down the dock the operator is using to
 * stop something.
 */
export const backgroundTaskOutput = (sessionId: string, taskId: string) =>
  Effect.gen(function* () {
    const tasks = yield* BackgroundTaskStore.list(sessionId);
    const file = tasks.find((t) => t.id === taskId)?.outputFile;
    if (!file) return "";
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  });

const allSessionChats = (session: Session | null) =>
  session ? [...session.chats, ...(session.closedChats ?? [])] : [];

// A failed archive/delete retains admission ownership for an explicit retry.
// Only this coordinator can transfer that token; concurrent callers cannot reuse it.
const lifecycleClosures = new Map<string, symbol>();
const lifecycleOperations = new Set<string>();
const beginWorkspaceLifecycle = (sessionId: string, reason: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId).pipe(Effect.mapError((cause) => new GitError({ message: "Session not found for workspace lifecycle", cause })));
    if (session.checkpointPtyHistory) return yield* Effect.fail(new GitError({ message: "Interactive terminal descendants cannot be proven stopped, including after restart. Archive/delete is refused; the ordinary workspace remains usable." }));
    const owner = yield* Effect.try({
      try: () => {
        if (lifecycleOperations.has(sessionId)) throw new Error("Workspace lifecycle operation is already in progress.");
        const previous = lifecycleClosures.get(sessionId);
        if (previous && !reopenWorkspaceAdmission(sessionId, previous)) throw new Error("Workspace lifecycle ownership changed.");
        const token = closeWorkspaceAdmission(sessionId, reason);
        lifecycleClosures.set(sessionId, token);
        lifecycleOperations.add(sessionId);
        return token;
      },
      catch: (cause) => new GitError({ message: cause instanceof Error ? cause.message : "Workspace is unavailable", cause }),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => lifecycleOperations.delete(sessionId)));
    return owner;
  });

/** `Sessions.archive` handler — archive a session and return the updated record. */
export const archiveSession = (
  sessionId: string,
  reason: "merged" | "closed",
  skipCleanup = false,
  metadataOnlyAcknowledged = false,
) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId);
    if (session.checkpointPtyHistory && metadataOnlyAcknowledged) {
      return yield* archiveMetadataOnly(sessionId, reason, metadataOnlyAcknowledged);
    }
    const workflow = yield* WorkspaceWorkflowService;
    yield* workflow.prepareLifecycle(sessionId);
    const closure = yield* beginWorkspaceLifecycle(sessionId, "workspace archive is in progress");
    const runner = yield* AgentRunner;
    const terminals = yield* TerminalService;
    for (const chat of [...session.chats, ...(session.closedChats ?? [])]) {
      yield* runner.stop(sessionId, chat.id, true);
    }
    yield* terminals.killSession(sessionId).pipe(
      Effect.mapError((cause) => new GitError({ message: cause.message, cause })),
    );
    yield* workflow.stopAll(sessionId);
    yield* Effect.tryPromise({
      try: () => waitForWorkspaceIdle(sessionId),
      catch: (cause) => new GitError({ message: "Workspace activity did not stop before archive", cause }),
    });
    if (!skipCleanup) yield* workflow.cleanup(sessionId, closure);
    yield* SessionStore.archive(sessionId, reason);
    const worktreePath = session.worktreePath;
    if (worktreePath) {
      yield* Effect.tryPromise(() => disposeLanguageIntelligence(worktreePath)).pipe(Effect.ignore);
    }
    const offload = yield* makeOffloadCommandRouter
    yield* offload.destroySession(sessionId).pipe(Effect.ignore)
    const route = yield* GitHubAuth.sessionRoutes().pipe(
      Effect.map(
        (routes) =>
          routes.find((candidate) => candidate.sessionId === sessionId) ?? null,
      ),
      Effect.orElseSucceed(() => null),
    );
    if (route)
      yield* GitHubAuth.archiveSessionRoute(route.relaySessionId).pipe(
        Effect.ignore,
      );
    return yield* SessionStore.get(sessionId);
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(new GitError({ message: "Session not found" })),
    ),
    Effect.scoped,
  );

export const archiveSessionRouted = (
  sessionId: string,
  reason: "merged" | "closed",
  skipCleanup = false,
  metadataOnlyAcknowledged = false,
) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId);
    const remote = yield* RemoteSessionService;
    return yield* routeSessionOperation(
      session,
      "Sessions.archive",
      { reason, skipCleanup, metadataOnlyAcknowledged },
      { execute: () => archiveSession(sessionId, reason, skipCleanup, metadataOnlyAcknowledged) },
      {
        execute: () =>
          remote.request(session, "Sessions.archive", { reason, skipCleanup, metadataOnlyAcknowledged }).pipe(
            Effect.flatMap(Schema.decodeUnknown(SessionSchema)),
            Effect.flatMap(SessionStore.upsertRemote),
            Effect.mapError(
              (cause) =>
                new GitError({
                  message: "Could not archive the remote session",
                  cause,
                }),
            ),
          ),
      },
    );
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(new GitError({ message: "Session not found" })),
    ),
  );

/** `Sessions.restore` handler — un-archive a session and return the updated record. */
export const restoreSession = (sessionId: string) =>
  Effect.gen(function* () {
    const closure = yield* beginWorkspaceLifecycle(sessionId, "workspace restoration is in progress");
    yield* SessionStore.restore(sessionId);
    yield* SessionStore.setWorkspaceLifecycle(sessionId, {
      status: "ready",
      updatedAt: new Date().toISOString(),
    });
    reopenWorkspaceAdmission(sessionId, closure);
    lifecycleClosures.delete(sessionId);
    const session = yield* SessionStore.get(sessionId);
    if (session.worktreePath) {
      const offload = yield* makeOffloadCommandRouter
      yield* Effect.forkDaemon(
        offload.primeSession(session.worktreePath, session.id).pipe(Effect.ignore)
      )
    }
    if (
      linkedRelaySession(session) &&
      session.githubInstallationId &&
      session.githubRepositoryId &&
      session.prNumber !== null
    ) {
      yield* GitHubAuth.upsertSessionRoute({
        sessionId: session.id,
        installationId: session.githubInstallationId,
        repositoryId: session.githubRepositoryId,
        pullRequestNumber: session.prNumber,
      }).pipe(Effect.ignore);
    }
    return session;
  }).pipe(
    Effect.scoped,
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(new GitError({ message: "Session not found" })),
    ),
  );

/** `Sessions.rename` handler — pin a manual title and return the updated record. */
export const renameSession = (sessionId: string, title: string) =>
  Effect.gen(function* () {
    yield* SessionStore.renameTitle(sessionId, title);
    return yield* SessionStore.get(sessionId);
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(new GitError({ message: "Session not found" })),
    ),
  );

/** `Sessions.setStatus` handler — record a settled turn's lifecycle status. */
export const setSessionStatus = (
  sessionId: string,
  status: SettledSessionStatus,
) =>
  Effect.gen(function* () {
    yield* SessionStore.setStatus(sessionId, status);
    return yield* SessionStore.get(sessionId);
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(new GitError({ message: "Session not found" })),
    ),
  );

/** `Sessions.setPersistent` handler — persist and return the updated record. */
export const setSessionPersistent = (sessionId: string, persistent: boolean) =>
  SessionStore.setPersistent(sessionId, persistent).pipe(
    Effect.catchTag("SessionNotFoundError", (cause) =>
      Effect.fail(new GitError({ message: "Session not found", cause })),
    ),
  );

/** `Github.files` handler — the PR's changed files (empty without a linked PR). */
export const githubFiles = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId);
    if (!session?.worktreePath || session.prNumber === null) return [];
    return yield* GitHubApi.prFiles(session.worktreePath, session.prNumber);
  });

/** `Github.diff` handler — the PR's unified diff (empty without a linked PR). */
export const githubDiff = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId);
    if (!session?.worktreePath || session.prNumber === null) return "";
    return yield* GitHubApi.prDiff(session.worktreePath, session.prNumber);
  });

/** `Review.get` handler — the stored review for the active PR, or null. */
export const reviewGet = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* sessionWithPr(sessionId);
    if (session === null) return null;
    const review = yield* ReviewStore.get(sessionId);
    return review?.prNumber === session.prNumber ? review : null;
  });

/**
 * Strip image payload bytes from transcripts before they cross into the
 * renderer. Metadata stays intact so the renderer can fetch each attachment
 * lazily through `Sessions.attachment`.
 */
export const withoutAttachmentData = (
  messages: ReadonlyArray<Message>,
): ReadonlyArray<Message> =>
  messages.map((message) => {
    if (!message.parts.some((part) => part._tag === "Image")) return message;
    return {
      ...message,
      parts: message.parts.map((part) =>
        part._tag === "Image"
          ? { ...part, attachment: { ...part.attachment, data: "" } }
          : part,
      ),
    };
  });

/**
 * `Review.markRouted` handler — record that the stored review's critical/major
 * findings reached the agent, and return the stamp.
 *
 * Idempotent: an already-routed review keeps its original stamp rather than
 * taking a fresh one. The renderer calls this from an effect, and an effect can
 * fire twice (StrictMode, a re-render, two panes mounted on the same session) —
 * the stamp is a fact about the first routing, not about the last call.
 *
 * Returns null when there is no stored review to stamp. The renderer treats that
 * as "don't claim it's routed", which is the safe direction: the alternative is a
 * review that reads as sent while the agent never heard about it.
 */
export const reviewMarkRouted = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* sessionWithPr(sessionId);
    if (session === null) return null;
    const review = yield* ReviewStore.get(sessionId);
    if (review === null || review.prNumber !== session.prNumber) return null;
    if (review.routedAt !== null) return review.routedAt;
    const now = yield* Effect.sync(() => new Date().toISOString());
    yield* ReviewStore.set(sessionId, { ...review, routedAt: now }).pipe(
      Effect.ignore,
    );
    return now;
  });

/**
 * `Review.reconcile` handler — credit the commits that fixed outstanding findings.
 *
 * Returns null when nothing changed, which is the common case and the whole
 * reason the RPC is shaped this way: the renderer calls it on every settled turn,
 * and a non-null answer is its signal to publish. See the contract's doc.
 *
 * Everything here degrades to "leave it alone" rather than to an error. A review
 * that can't be reconciled (no worktree, an unreachable head SHA after a force
 * push, an unwritable reviews dir) should show its findings as still outstanding
 * — which is exactly what the stored review already says.
 *
 * Exported for tests.
 */
export const reviewReconcile = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* sessionWithPr(sessionId);
    if (!session?.worktreePath) return null;
    const review = yield* ReviewStore.get(sessionId);
    if (review === null || review.prNumber !== session.prNumber) return null;

    const commits = yield* GitService.commitsSince(
      session.worktreePath,
      review.headSha,
    );
    const now = yield* Effect.sync(() => new Date().toISOString());
    const findings = resolveFindings(review.findings, commits, now);
    // Identity, not deep equality: `resolveFindings` hands back the same array
    // when it attributed nothing, which is the fast path this leans on.
    if (findings === review.findings) return null;

    const next = { ...review, findings };
    yield* ReviewStore.set(sessionId, next).pipe(Effect.ignore);
    return next;
  });

const configuredReviewRuntime = (configured: AgentModelSelection) => {
  const connectionId = configured.runtimeId === "pi"
    ? providerConnectionIdForPiEndpoint(configured.endpointId, "desktop") ?? undefined
    : undefined;
  if (configured.runtimeId === "pi" && connectionId === undefined) return null;
  return { ...configured, connectionId, targetId: "desktop" };
};

const sessionReviewRuntime = (session: Session) => {
  const runtimeId = session.runtimeId ?? (
    session.connectionId === undefined ? undefined : "pi"
  );
  if (runtimeId === undefined) return null;
  const targetId = session.environmentId ?? "desktop";
  const endpointId = session.endpointId ?? (
    runtimeId === "pi" && session.connectionId !== undefined
      ? piEndpointId(targetId, session.connectionId)
      : undefined
  );
  if (
    endpointId === undefined ||
    session.providerId === undefined ||
    session.modelId === undefined ||
    (runtimeId === "pi" && session.connectionId === undefined)
  ) return null;
  return {
    runtimeId,
    endpointId,
    connectionId: session.connectionId,
    providerId: session.providerId,
    modelId: session.modelId,
    targetId,
  };
};

const reviewRuntimeSelection = (
  session: Session,
  configured: AgentModelSelection | undefined,
) => configured === undefined
  ? sessionReviewRuntime(session)
  : configuredReviewRuntime(configured);

const reviewLocations = (
  session: Session,
  worktreePath: string,
  configured: AgentModelSelection | undefined,
) => Effect.gen(function* () {
  if (session.environmentId === undefined) {
    return { githubTarget: worktreePath, cwd: worktreePath };
  }
  if (session.githubSlug === undefined) {
    return yield* Effect.fail(new ReviewError({
      message: "This remote session is missing its GitHub repository identity.",
    }));
  }
  const githubTarget = `github-slug:${session.githubSlug}`;
  if (configured === undefined) return { githubTarget, cwd: worktreePath };
  const cwd = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(resolve(tmpdir(), "jingler-adversarial-review-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );
  return { githubTarget, cwd };
});

/**
 * `Review.run` handler — run an adversarial review of the session's linked PR.
 *
 * The head-SHA short-circuit is the load-bearing part: it means an unchanged PR
 * costs one cheap GitHub API read instead of an agent run. That is what lets the
 * auto-review trigger fire naively off the renderer's poll loop without needing
 * a client-side guard of its own — a duplicate effect is simply a no-op.
 *
 * Exported for tests.
 */
export const reviewRun = (sessionId: string, force: boolean) =>
  Effect.gen(function* () {
    const session = yield* sessionWithPr(sessionId);
    if (!session?.worktreePath) {
      return yield* Effect.fail(
        new ReviewError({
          message: "This session has no linked pull request to review.",
        }),
      );
    }

    const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null));
    const configured = config?.github?.adversarialReviewModel;
    const locations = yield* reviewLocations(session, session.worktreePath, configured);
    const headSha = yield* GitHubApi.prHeadSha(
      locations.githubTarget,
      session.prNumber,
    );
    if (headSha === null) {
      return yield* Effect.fail(
        new ReviewError({
          message: "Could not resolve the pull request's head commit.",
        }),
      );
    }

    // The de-dupe. Note it runs BEFORE the diff read and the agent spawn — the
    // whole point is that an unchanged head is nearly free.
    const prior = yield* ReviewStore.get(sessionId);
    if (
      !force &&
      prior !== null &&
      prior.prNumber === session.prNumber &&
      prior.headSha === headSha
    ) {
      return prior;
    }

    const runtime = reviewRuntimeSelection(session, configured);
    if (runtime === null) {
      return yield* Effect.fail(
        new ReviewError({
          message: "Choose an adversarial review model in GitHub settings before running a review.",
        }),
      );
    }
    const diff = yield* GitHubApi.prDiff(
      locations.githubTarget,
      session.prNumber,
    );

    const review = yield* ReviewService.run({
      sessionId,
      prNumber: session.prNumber,
      headSha,
      cwd: locations.cwd,
      repo: session.repo,
      branch: session.branch,
      baseBranch: session.baseBranch ?? null,
      runtimeId: runtime.runtimeId,
      endpointId: runtime.endpointId,
      ...(runtime.connectionId === undefined ? {} : { connectionId: runtime.connectionId }),
      providerId: runtime.providerId,
      modelId: runtime.modelId,
      targetId: runtime.targetId,
      diff,
    });

    const postToPr = yield* ConfigService.get().pipe(
      Effect.map((latest) => latest?.github?.postAdversarialReviewComments ?? true),
      Effect.orElseSucceed(() => false),
    );
    const routedReview = { ...review, postToPr };

    // Post the minor/nit half to the PR as inline comments when enabled. The
    // renderer routes everything locally when posting is disabled.
    //
    // Deliberately below the de-dupe: only a FRESH run posts. The short-circuit
    // above returns `prior` untouched, so a poll tick on an unchanged head can
    // never re-post the same nits.
    const posted = postToPr
      ? yield* postReviewToPr(
          locations.githubTarget,
          session.prNumber,
          routedReview,
          diff,
        )
      : routedReview;

    // Persist best-effort: a review the user can see now matters more than one
    // we can re-read later, and a failed write must not fail the run.
    yield* ReviewStore.set(sessionId, posted).pipe(Effect.ignore);
    return posted;
  }).pipe(Effect.scoped);

/**
 * Post a review's low-severity findings to the PR, returning the review stamped
 * with the outcome.
 *
 * **Best-effort by construction.** A review costs real tokens on a frontier
 * model, and its verdict is just as true whether or not GitHub accepted the
 * comments — so every failure here lands in `postError` and the findings survive.
 * Failing the run instead would throw away the whole review over an API hiccup,
 * and (because the caller persists only on success) leave the auto-trigger
 * re-running the reviewer on the same head every tick.
 */
const postReviewToPr = (
  cwd: string,
  prNumber: number,
  review: AdversarialReview,
  diff: string,
): Effect.Effect<
  AdversarialReview,
  never,
  GitHubApi | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const plan = planReviewPost(review, diff);
    // Nothing low-severity to say. Not an error, and not a failed post — leave
    // both stamps null so the UI reads it as "there was nothing to post".
    if (plan === null) return review;

    const now = yield* Effect.sync(() => new Date().toISOString());
    return yield* GitHubApi.prReviewComments(cwd, prNumber, {
      commitSha: review.headSha,
      body: plan.body,
      comments: plan.comments,
    }).pipe(
      Effect.as({ ...review, postedAt: now, postError: null }),
      Effect.catchAll((cause) =>
        Effect.succeed({
          ...review,
          postedAt: null,
          postError: `Couldn't post the low-severity findings to the pull request: ${cause.message}`,
        }),
      ),
    );
  });

/**
 * `Github.detectPr` handler. Looks up a PR open on the session's branch and, when
 * found, links it (persists `prNumber`). Returns the number, or null. Exported for tests.
 */
export const githubDetectPr = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId);
    if (!session?.worktreePath) return null;
    // Resolve against the worktree's live branch — the stored `session.branch`
    // drifts once the agent checks out / creates a different branch there.
    const [n, liveBranch] = yield* Effect.all([
      GitHubApi.prForWorktree(session.worktreePath),
      GitService.branchAt(session.worktreePath),
    ]);
    if (n === null) return null;
    const persistLink = SessionStore.setPrNumber(session.id, n).pipe(
      Effect.zipRight(
        liveBranch === null ? Effect.void : SessionStore.setBranch(session.id, liveBranch),
      ),
    );
    yield* persistLink.pipe(
      Effect.mapError((error) => new GitHubApiError({
        reason: "unavailable",
        message: error.message,
      })),
    );
    // Stop any old PR route before attempting to hydrate the new App identity.
    yield* Effect.promise(refreshGitHubRelaySupervisors);
    // App identity is optional for CLI-linked PRs. Hydrate it only when this
    // repository is installed, which is what makes realtime routing available.
    yield* Effect.gen(function* () {
      const repository = yield* GitHubApi.repository(session.worktreePath!);
      if (repository.installationId === undefined) return;
      yield* SessionStore.setGitHubLink(session.id, {
        installationId: repository.installationId,
        repositoryId: repository.id,
        prNumber: n,
      });
      yield* GitHubAuth.upsertSessionRoute({
        sessionId: session.id,
        installationId: repository.installationId,
        repositoryId: repository.id,
        pullRequestNumber: n,
      });
      yield* Effect.promise(refreshGitHubRelaySupervisors);
    }).pipe(Effect.ignore);
    return n;
  });

const hydrateGitHubSessionLinks = (
  list: () => Promise<ReadonlyArray<Session>>,
  repository: (worktreePath: string) => Promise<GitHubRepository>,
  link: (
    sessionId: string,
    identity: {
      readonly installationId: string;
      readonly repositoryId: string;
      readonly prNumber: number;
    },
  ) => Promise<void>,
): Promise<void> =>
  list().then(async (sessions) => {
    for (const session of sessions) {
      if (
        session.prNumber === null ||
        !session.worktreePath ||
        (session.githubInstallationId && session.githubRepositoryId)
      ) {
        continue;
      }
      try {
        const resolved = await repository(session.worktreePath);
        if (resolved.installationId !== undefined) {
          await link(session.id, {
            installationId: resolved.installationId,
            repositoryId: resolved.id,
            prNumber: session.prNumber,
          });
        }
      } catch {
        // A stale/inaccessible legacy session remains safely unlinked.
      }
    }
  });

const linkedRelaySession = (session: Session): boolean =>
  !session.archived &&
  session.prNumber !== null &&
  Boolean(session.githubInstallationId && session.githubRepositoryId);

export const reconcileRelaySessionRoutes = async (
  listSessions: () => Promise<ReadonlyArray<Session>>,
  listRoutes: () => Promise<ReadonlyArray<GitHubSessionRoute>>,
  archive: (route: GitHubSessionRoute) => Promise<void>,
  register: (session: Session) => Promise<GitHubSessionRoute>,
): Promise<ReadonlyArray<GitHubSessionRoute>> => {
  const sessions = (await listSessions()).filter(linkedRelaySession);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const routes = [...(await listRoutes())];
  const active = new Map(
    routes
      .filter((route) => route.state === "active")
      .map((route) => [route.sessionId, route]),
  );
  for (const [sessionId, route] of active) {
    if (byId.has(sessionId)) continue;
    await archive(route);
    active.delete(sessionId);
  }
  for (const session of sessions) {
    const route = active.get(session.id);
    if (
      route &&
      route.installationId === session.githubInstallationId &&
      route.repositoryId === session.githubRepositoryId &&
      route.pullRequestNumber === session.prNumber
    ) {
      continue;
    }
    if (route) {
      await archive(route);
      active.delete(session.id);
    }
    const registered = await register(session);
    active.set(session.id, registered);
  }
  return [...active.values()].filter((route) => {
    const session = byId.get(route.sessionId);
    return (
      session !== undefined &&
      route.installationId === session.githubInstallationId &&
      route.repositoryId === session.githubRepositoryId &&
      route.pullRequestNumber === session.prNumber
    );
  });
};

/**
 * How long a delivery may sit un-acknowledged before it is treated as failed.
 *
 * The renderer's acknowledgement can legitimately take a while while the target
 * conversation loads and admits the instruction to its visible queue. It must
 * not wait for that item to run: doing so hides every later relay frame behind
 * the current agent turn. An acknowledgement that never comes still wedges the
 * connection's serial delivery chain, freezes the cursor, and
 * silently blocks every later event for that session until the app restarts.
 * Timing out rejects instead, which closes the socket and replays the frame.
 */
export const RELAY_ACKNOWLEDGEMENT_TIMEOUT_MS = 5 * 60_000;

export const awaitRelayAcknowledgement = (
  delivery: GitHubRelayDelivery,
  offer: (delivery: GitHubRelayDelivery) => void,
  timeoutMs: number = RELAY_ACKNOWLEDGEMENT_TIMEOUT_MS,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const key = relayAcknowledgementKey(delivery.clientId, delivery.cursor);
    const timer = setTimeout(() => {
      if (pendingRelayAcknowledgements.get(key) !== pending) return;
      pendingRelayAcknowledgements.delete(key);
      reject(
        new Error(
          `GitHub relay delivery ${delivery.event.deliveryId} was not acknowledged in time`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    const pending: PendingRelayAcknowledgement = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    };
    pendingRelayAcknowledgements.set(key, pending);
    offer(delivery);
  });

/** A transcript append is the durable visible-instruction acceptance boundary. */
export const transcriptHasGitHubFeedback = (
  transcript: ReadonlyArray<Message>,
  event: Pick<GitHubRelayEvent, "deliveryId" | "semanticKey">,
): boolean =>
  transcript.some(
    (message) =>
      message.externalInstruction?.deliveryId === event.deliveryId ||
      message.externalInstruction?.semanticKey === event.semanticKey,
  );

export const completeDurableGitHubFeedbackReplay = async (input: {
  readonly transcript: ReadonlyArray<Message>;
  readonly event: Pick<GitHubRelayEvent, "deliveryId" | "semanticKey">;
  readonly claim: () => Promise<GitHubFeedbackClaimStatus>;
  readonly markDispatched: () => Promise<boolean>;
}): Promise<boolean> => {
  if (!transcriptHasGitHubFeedback(input.transcript, input.event)) return false;
  const claim = await input.claim();
  if (claim === "rejected") {
    throw new Error(
      "The GitHub feedback replay no longer belongs to this session",
    );
  }
  if (claim === "pending" && !(await input.markDispatched())) {
    throw new Error(
      "The durable GitHub feedback replay could not be completed",
    );
  }
  return true;
};

/** Verified relay events held unacknowledged until renderer routing settles. */
export const githubEvents = () =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox.make<GitHubRelayStreamMessage>();
      const runtime = yield* Effect.runtime<
        | GitHubAuth
        | GitHubApi
        | GitHubEventStore
        | SessionStore
        | TranscriptStore
        | AppPaths
        | FileSystem.FileSystem
        | Path.Path
      >();
      const run = Runtime.runPromise(runtime);
      const listSessions = () => run(SessionStore.list());
      yield* Effect.tryPromise(() =>
        hydrateGitHubSessionLinks(
          listSessions,
          (worktreePath) => run(GitHubApi.repository(worktreePath)),
          (sessionId, identity) =>
            run(SessionStore.setGitHubLink(sessionId, identity)),
        ),
      ).pipe(Effect.ignore);
      const ownedClientIds = new Set<string>();
      const supervisor = new GitHubRelaySupervisor({
        listSessions: async () => {
          // Read the persisted topology. Explicit GitHub refreshes and webhook
          // lifecycle mutations maintain it; a relay supervisor tick must not
          // fan out into GitHub API calls for every linked session.
          const status = await run(GitHubAuth.status());
          const routes = await reconcileRelaySessionRoutes(
            listSessions,
            () => run(GitHubAuth.sessionRoutes()),
            (route) =>
              run(GitHubAuth.archiveSessionRoute(route.relaySessionId)).then(
                () => undefined,
              ),
            (session) =>
              run(
                GitHubAuth.upsertSessionRoute({
                  sessionId: session.id,
                  installationId: session.githubInstallationId!,
                  repositoryId: session.githubRepositoryId!,
                  pullRequestNumber: session.prNumber!,
                }),
              ),
          );
          return routes
            .filter((route) =>
              installationCanRouteRepository(
                status.installations,
                route.installationId,
                route.repositoryId,
              ),
            )
            .map((route) => ({
              sessionId: route.sessionId,
              relaySessionId: route.relaySessionId,
              installationId: route.installationId,
            }));
        },
        createConnection: async (target, onStatus, retryCoordinator) => {
          const clientId = await run(
            GitHubEventStore.clientId(target.relaySessionId),
          );
          ownedClientIds.add(clientId);
          return new GitHubRelayConnection({
            clientId,
            grant: () => run(GitHubAuth.grantForSession(target.relaySessionId)),
            cursorStore: {
              load: () => run(GitHubEventStore.cursor(clientId)),
              save: (_ignored, cursor) =>
                run(GitHubEventStore.setCursor(clientId, cursor)),
            },
            dial: dialGitHubRelay,
            onStatus,
            retryCoordinator,
            onEvent: async (event, cursor) => {
              const session = await run(SessionStore.get(target.sessionId));
              if (!linkedRelaySession(session)) {
                throw new Error("The GitHub relay session is no longer active");
              }
              const transcript = await run(
                TranscriptStore.list(session.activeChatId),
              );
              if (
                await completeDurableGitHubFeedbackReplay({
                  transcript,
                  event,
                  claim: () =>
                    run(
                      SessionStore.claimGitHubFeedback(session.id, {
                        installationId: session.githubInstallationId!,
                        repositoryId: session.githubRepositoryId!,
                        prNumber: session.prNumber!,
                        deliveryId: event.deliveryId,
                        semanticKey: event.semanticKey,
                        event,
                      }),
                    ),
                  markDispatched: () =>
                    run(
                      SessionStore.markGitHubFeedbackDispatched(
                        session.id,
                        event.deliveryId,
                        event.semanticKey,
                      ),
                    ),
                })
              )
                return;
              await awaitRelayAcknowledgement(
                {
                  clientId,
                  cursor,
                  event,
                  relaySessionId: target.relaySessionId,
                  sessionId: session.id,
                  chatId: session.activeChatId,
                },
                (delivery) => mailbox.unsafeOffer(delivery),
              );
            },
          });
        },
        onStatus: (status) => {
          mailbox.unsafeOffer({
            relaySessionId: status.relaySessionId || null,
            sessionId: status.sessionId || null,
            installationId: status.installationId,
            mode: status.mode,
            error: status.mode === "error" ? status.error : null,
          });
        },
      });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            supervisor.stop();
            for (const [key, pending] of pendingRelayAcknowledgements) {
              if (
                ![...ownedClientIds].some((clientId) =>
                  key.startsWith(`${clientId}:`),
                )
              ) {
                continue;
              }
              pendingRelayAcknowledgements.delete(key);
              pending.reject(new Error("GitHub relay stream closed"));
            }
          });
          yield* mailbox.end;
        }),
      );
      yield* Effect.tryPromise(() => supervisor.start());
      // Re-drive feedback that was claimed but never finished routing. A relay
      // replay cannot recover these: their cursor may already be acknowledged
      // (the route resolved down an "ignored" branch), so the Durable Object
      // will never send the frame again. The recovery pass validates each
      // entry against current session state and hands back only the ones a
      // fresh claim would still accept; each is offered through the same
      // mailbox as a live delivery, so the renderer routes and acknowledges it
      // identically. A failed or timed-out attempt stays pending for the next
      // recovery pass rather than being dropped.
      yield* Effect.forkScoped(
        Effect.tryPromise(async () => {
          const entries = await run(
            SessionStore.recoverGitHubFeedbackOutbox(),
          );
          for (const [index, entry] of entries.entries()) {
            const clientId = `outbox-replay:${entry.sessionId}`;
            ownedClientIds.add(clientId);
            try {
              await awaitRelayAcknowledgement(
                {
                  clientId,
                  cursor: index + 1,
                  event: entry.event,
                  relaySessionId: "outbox-replay",
                  sessionId: entry.sessionId,
                  chatId: entry.chatId,
                },
                (delivery) => mailbox.unsafeOffer(delivery),
              );
            } catch {
              // Still pending; the next stream start retries it.
            }
          }
        }).pipe(Effect.ignore),
      );
      return Mailbox.toStream(mailbox);
    }),
  ).pipe(Stream.catchAll(() => Stream.empty));

const publishFailure = (
  message: string,
  previous?: PublishCheckpoint,
): PublishCheckpoint => ({
  step: "failed",
  completed: previous?.completed ?? [],
  ...(previous?.metadata ? { metadata: previous.metadata } : {}),
  ...(previous?.branch ? { branch: previous.branch } : {}),
  ...(previous?.commitSha ? { commitSha: previous.commitSha } : {}),
  ...(previous?.prNumber !== undefined ? { prNumber: previous.prNumber } : {}),
  error: message,
  resumeFrom: "inspecting",
  updatedAt: new Date().toISOString(),
});

/**
 * Re-read a session when semantic branch activation may have raced publication.
 *
 * Fresh sessions start detached and persist their semantic branch in a separate
 * operation. Capturing the session before that write and comparing it with git
 * afterwards used to reject the valid live branch as an external branch change.
 */
export const resolvePublishSessionBranch = async (
  captured: Session,
  liveBranch: string | null,
  refresh: () => Promise<Session>,
): Promise<{ readonly session: Session; readonly branch: string }> => {
  const session =
    captured.semanticBranchPending === true || liveBranch !== captured.branch
      ? await refresh()
      : captured;
  if (session.semanticBranchPending === true) {
    throw new Error(
      "Finish creating the semantic task branch before publishing.",
    );
  }
  if (!liveBranch) {
    throw new Error(
      "The task worktree is detached. Finish semantic branch creation before publishing.",
    );
  }
  if (liveBranch !== session.branch) {
    throw new Error(
      `The worktree branch changed to ${liveBranch}. Refresh the session before publishing.`,
    );
  }
  if (!isSessionPublishBranchReady(session, liveBranch)) {
    if (workspaceModeOf(session) === "direct") {
      throw new Error("Publishing requires an isolated session worktree.");
    }
    throw new Error("The worktree is not on a validated semantic task branch.");
  }
  return { session, branch: liveBranch };
};

/**
 * `Github.publish` is the sole mutation owner for publishing session work.
 * Installation credentials are captured only in this main-process scope and
 * cleared immediately after the authenticated push.
 */
export const githubPublish = (sessionId: string) =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox.make<PublishCheckpoint>();
      const agentRuntime = yield* AgentRuntime;
      const runtime = yield* Effect.runtime<
        | GitService
        | GitHubApi
        | GitHubAuth
        | SessionStore
        | TranscriptStore
        | CommandExecutor.CommandExecutor
        | AppPaths
        | FileSystem.FileSystem
        | Path.Path
      >();
      const run = Runtime.runPromise(runtime);
      const offer = (checkpoint: PublishCheckpoint): void => {
        mailbox.unsafeOffer(checkpoint);
      };

      yield* Effect.forkScoped(
        Effect.tryPromise({
          try: async () => {
            let session = await run(SessionStore.get(sessionId));
            if (session.checkpointSafeMode) throw new Error("Publishing invokes unsupported Git commands in checkpoint-safe mode. Disable safe mode before publishing.");
            if (!session.worktreePath) {
              const failure = publishFailure(
                "This session has no worktree to publish.",
                session.publish,
              );
              await run(SessionStore.setPublishCheckpoint(session.id, failure));
              offer(failure);
              return;
            }

            const cwd = session.worktreePath;
            let repositoryIdentity: {
              readonly id: string;
              readonly installationId?: string;
              readonly fullName: string;
            } | null = null;
            let pushCredential: { readonly token: string } | null = null;
            let pushPermissions: ReadonlyArray<string> = ["contents:write"];
            const messages = await run(
              TranscriptStore.list(session.activeChatId),
            );
            try {
              await runPublishMachineExclusive(
                session.id,
                session.publish,
                {
                  knownPrNumber: session.prNumber,
                  inspect: async () => {
                    const inspection = await run(
                      GitService.publishInspection(
                        cwd,
                        session.baseBranch ?? "main",
                      ),
                    );
                    pushPermissions = githubPushPermissions(
                      inspection.changedPaths,
                    );
                    return inspection;
                  },
                  verifyBranch: async (inspection) => {
                    const resolved = await resolvePublishSessionBranch(
                      session,
                      inspection.branch,
                      () => run(SessionStore.get(sessionId)),
                    );
                    session = resolved.session;
                    return resolved.branch;
                  },
                  generateMetadata: (inspection) =>
                    run(
                      makeAgentRuntimePublishMetadataGenerator(
                        agentRuntime,
                      ).generate({
                        session,
                        messages,
                        changedPaths: inspection.changedPaths,
                        diffSummary: inspection.diffSummary,
                      }),
                    ),
                  stage: async () => {
                    await run(GitService.stageAll(cwd));
                    if (!(await run(GitService.hasStagedChanges(cwd)))) {
                      throw new Error(
                        "Git found no staged changes to commit. Review ignored files and try again.",
                      );
                    }
                  },
                  commit: (message) => {
                    if (!isCommitSubjectSafe(message)) {
                      throw new Error(
                        "The generated commit subject was not safe to publish.",
                      );
                    }
                    return run(GitService.commit(cwd, message));
                  },
                  authenticate: async () => {
                    const repository = await run(GitHubApi.repository(cwd));
                    repositoryIdentity = repository;
                    if (repository.installationId !== undefined) {
                      pushCredential = await run(
                        GitHubAuth.credentialsForInstallation(
                          repository.installationId,
                          repository.fullName,
                          pushPermissions,
                        ),
                      );
                    }
                  },
                  push: async (branch) => {
                    const repository =
                      repositoryIdentity ??
                      (await run(GitHubApi.repository(cwd)));
                    if (!pushCredential) {
                      await run(GitService.pushConfigured(cwd, branch));
                      return;
                    }
                    try {
                      await run(
                        GitService.pushWithInstallationToken(
                          cwd,
                          branch,
                          repository.fullName,
                          pushCredential.token,
                        ),
                      );
                    } finally {
                      pushCredential = null;
                    }
                  },
                  resolvePr: (branch) =>
                    run(GitHubApi.prForBranch(cwd, branch)),
                  createPr: async (metadata) => {
                    return run(
                      GitHubApi.prCreate(cwd, {
                        title: metadata.prTitle,
                        body: metadata.prBody,
                        base: session.baseBranch ?? "main",
                        draft: false,
                      }),
                    );
                  },
                  updatePr: (number, metadata) =>
                    run(
                      GitHubApi.prUpdate(cwd, number, {
                        title: metadata.prTitle,
                        body: metadata.prBody,
                      }),
                    ),
                  link: async (number) => {
                    const repository =
                      repositoryIdentity ??
                      (await run(GitHubApi.repository(cwd)));
                    await run(SessionStore.setPrNumber(session.id, number));
                    if (repository.installationId !== undefined) {
                      await run(
                        SessionStore.setGitHubLink(session.id, {
                          installationId: repository.installationId,
                          repositoryId: repository.id,
                          prNumber: number,
                        }),
                      );
                      await run(
                        GitHubAuth.upsertSessionRoute({
                          sessionId: session.id,
                          installationId: repository.installationId,
                          repositoryId: repository.id,
                          pullRequestNumber: number,
                        }),
                      );
                    }
                  },
                },
                async (checkpoint) => {
                  await run(
                    SessionStore.setPublishCheckpoint(session.id, checkpoint),
                  );
                },
                offer,
              );
            } finally {
              pushCredential = null;
            }
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.catchAll((cause) =>
            Effect.sync(() =>
              offer(
                publishFailure(
                  cause instanceof Error ? cause.message : "Publishing failed.",
                ),
              ),
            ),
          ),
          Effect.ensuring(mailbox.end),
        ),
      );
      return Mailbox.toStream(mailbox);
    }),
  );

export const githubPublishRouted = (sessionId: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId);
      const remote = yield* RemoteSessionService;
      return yield* routeSessionOperation(
        session,
        "Github.createPr",
        {},
        { execute: () => Effect.succeed(githubPublish(sessionId)) },
        {
          execute: () =>
            Effect.succeed(
              Stream.unwrapScoped(
                Effect.gen(function* () {
                  const mailbox = yield* Mailbox.make<PublishCheckpoint>();
                  let latest: PublishCheckpoint | undefined = session.publish;
                  const emit = (checkpoint: PublishCheckpoint) =>
                    SessionStore.setPublishCheckpoint(
                      session.id,
                      checkpoint,
                    ).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          latest = checkpoint;
                          mailbox.unsafeOffer(checkpoint);
                        }),
                      ),
                    );

                  const remoteResult = <A, I>(
                    operation: string,
                    payload: unknown,
                    schema: Schema.Schema<A, I>,
                  ) =>
                    remote.execute(session, operation, payload).pipe(
                      Stream.runCollect,
                      Effect.flatMap(decodeRemotePublishResult<A, I>(operation, schema)),
                    );

                  yield* Effect.forkScoped(
                    Effect.gen(function* () {
                      yield* emit({
                        step: "inspecting",
                        completed: [],
                        updatedAt: new Date().toISOString(),
                      });
                      const prepared = yield* remoteResult(
                        "Github.preparePublish",
                        {},
                        RemotePublishPreparedSchema,
                      );
                      const preparedFields = {
                        metadata: {
                          commitMessage: prepared.commitMessage,
                          prTitle: prepared.prTitle,
                          prBody: prepared.prBody,
                        },
                        branch: prepared.branch,
                        commitSha: prepared.commitSha,
                      };
                      const throughCommit = [
                        "inspecting",
                        "verifying-branch",
                        "generating-metadata",
                        "staging",
                        "committing",
                      ] as const;
                      yield* emit({
                        step: "pushing",
                        completed: throughCommit,
                        ...preparedFields,
                        updatedAt: new Date().toISOString(),
                      });
                      yield* emit({
                        step: "resolving-pr",
                        completed: [...throughCommit, "pushing"],
                        ...preparedFields,
                        updatedAt: new Date().toISOString(),
                      });
                      const existing =
                        prepared.existingPrNumber ??
                        (yield* GitHubApi.prForBranchBySlug(
                          prepared.githubSlug,
                          prepared.branch,
                        ));
                      const prStep =
                        existing === null ? "creating-pr" : "updating-pr";
                      yield* emit({
                        step: prStep,
                        completed: [
                          ...throughCommit,
                          "pushing",
                          "resolving-pr",
                        ],
                        ...preparedFields,
                        updatedAt: new Date().toISOString(),
                      });
                      const prNumber =
                        existing ??
                        (yield* GitHubApi.prCreateBySlug(
                          prepared.githubSlug,
                          prepared.branch,
                          {
                            title: prepared.prTitle,
                            body: prepared.prBody,
                            base: prepared.baseBranch,
                            draft: false,
                          },
                        ));
                      if (existing !== null) {
                        yield* GitHubApi.prUpdateBySlug(
                          prepared.githubSlug,
                          existing,
                          {
                            title: prepared.prTitle,
                            body: prepared.prBody,
                          },
                        );
                      }
                      yield* emit({
                        step: "linking",
                        completed: [
                          ...throughCommit,
                          "pushing",
                          "resolving-pr",
                          prStep,
                        ],
                        ...preparedFields,
                        prNumber,
                        updatedAt: new Date().toISOString(),
                      });
                      yield* remoteResult(
                        "Github.completePublish",
                        { prNumber },
                        SessionSchema,
                      );
                      yield* SessionStore.setPrNumber(session.id, prNumber);
                      yield* emit({
                        step: "complete",
                        completed: [
                          ...throughCommit,
                          "pushing",
                          "resolving-pr",
                          prStep,
                          "linking",
                          "complete",
                        ],
                        ...preparedFields,
                        prNumber,
                        updatedAt: new Date().toISOString(),
                      });
                    }).pipe(
                      Effect.catchAll((error) => {
                        const failure = publishFailure(
                          "message" in error &&
                            typeof error.message === "string"
                            ? error.message
                            : "Remote publishing failed.",
                          latest,
                        );
                        return SessionStore.setPublishCheckpoint(
                          session.id,
                          failure,
                        ).pipe(
                          Effect.catchAll(() => Effect.void),
                          Effect.andThen(
                            Effect.sync(() => mailbox.unsafeOffer(failure)),
                          ),
                        );
                      }),
                      Effect.ensuring(mailbox.end),
                    ),
                  );
                  return Mailbox.toStream(mailbox);
                }),
              ),
            ),
        },
      );
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed(
          Stream.make({
            step: "failed" as const,
            completed: [],
            error:
              "message" in error && typeof error.message === "string"
                ? error.message
                : "Publishing failed.",
            updatedAt: new Date().toISOString(),
          }),
        ),
      ),
    ),
  );

/**
 * `Github.comment` handler — post a top-level PR comment when `toGithub`. The
 * renderer separately feeds the body to the agent (`Agent.run`), so this only
 * owns the GitHub write.
 */
export const githubComment = (input: {
  sessionId: string;
  body: string;
  toGithub: boolean;
}) =>
  Effect.gen(function* () {
    if (!input.toGithub) return;
    const session = yield* resolveSession(input.sessionId);
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(
        new GitHubApiError({
          reason: "validation",
          message: "No linked pull request to comment on",
        }),
      );
    }
    yield* GitHubApi.prComment(
      session.worktreePath,
      session.prNumber,
      input.body,
    );
  });

export const githubCommentBySlug = (input: {
  repository: string;
  number: number;
  body: string;
}) =>
  input.body.trim()
    ? GitHubApi.prCommentBySlug(input.repository, input.number, input.body.trim())
    : Effect.fail(
        new GitHubApiError({
          reason: "validation",
          message: "Write a comment before posting.",
          repository: input.repository,
        }),
      );

export const githubCloseBySlug = (input: {
  repository: string;
  number: number;
}) => GitHubApi.prCloseBySlug(input.repository, input.number);

export const githubMergeBySlug = (input: {
  repository: string;
  number: number;
  method: PrMergeMethod;
}) => GitHubApi.prMergeBySlug(input.repository, input.number, input.method);

/**
 * `Github.submitReview` handler — post the reviewer's drafts as ONE COMMENT
 * review carrying line-anchored inline comments.
 *
 * Anchors against the PR's CURRENT diff and head sha rather than whatever the
 * renderer was looking at: a draft written minutes ago may sit on a line the
 * agent has since pushed over, and GitHub rejects the whole review over a single
 * stale line. `planDraftPost` folds those into the body instead.
 *
 * Returns the unanchored count so the renderer can say so.
 */
export const githubSubmitReview = (input: {
  sessionId: string;
  comments: ReadonlyArray<ReviewComment>;
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId);
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(
        new GitHubApiError({
          reason: "validation",
          message: "No linked pull request to review",
        }),
      );
    }
    const headSha = yield* GitHubApi.prHeadSha(
      session.worktreePath,
      session.prNumber,
    );
    if (headSha === null) {
      return yield* Effect.fail(
        new GitHubApiError({
          reason: "validation",
          message:
            "Couldn't resolve the pull request's head commit to anchor comments against",
        }),
      );
    }
    const diff = yield* GitHubApi.prDiff(
      session.worktreePath,
      session.prNumber,
    );
    const plan = planDraftPost(input.comments, diff);
    if (plan === null) return 0;

    yield* GitHubApi.prReviewComments(session.worktreePath, session.prNumber, {
      commitSha: headSha,
      body: plan.body,
      comments: plan.comments,
    });
    return plan.unanchoredCount;
  });

/** `Github.review` handler — submit a review (comment/approve/request-changes). */
export const githubReview = (input: {
  sessionId: string;
  kind: ReviewSubmitKind;
  body: string;
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId);
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(
        new GitHubApiError({
          reason: "validation",
          message: "No linked pull request to review",
        }),
      );
    }
    yield* GitHubApi.prReview(
      session.worktreePath,
      session.prNumber,
      input.kind,
      input.body,
    );
  });

/** `Github.resolveThread` handler — resolve/unresolve an inline review thread. */
export const githubResolveThread = (input: {
  sessionId: string;
  threadId: string;
  resolved: boolean;
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId);
    if (!session?.worktreePath) {
      return yield* Effect.fail(
        new GitHubApiError({
          reason: "validation",
          message: "No worktree to resolve the thread from",
        }),
      );
    }
    yield* GitHubApi.resolveThread(
      session.worktreePath,
      input.threadId,
      input.resolved,
    );
  });

/** `Github.replyToThread` handler — post a reply into an inline review thread. */
export const githubReplyToThread = (input: {
  sessionId: string;
  commentId: number;
  body: string;
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId);
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(
        new GitHubApiError({
          reason: "validation",
          message: "No linked pull request to reply to",
        }),
      );
    }
    yield* GitHubApi.replyToThread(
      session.worktreePath,
      session.prNumber,
      input.commentId,
      input.body,
    );
  });

/** `Github.merge` handler — merge the session's linked PR (merge commit by default). */
export const githubMerge = (input: {
  sessionId: string;
  method?: PrMergeMethod;
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId);
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(
        new GitHubApiError({
          reason: "validation",
          message: "No linked pull request to merge",
        }),
      );
    }
    yield* GitHubApi.prMerge(
      session.worktreePath,
      session.prNumber,
      input.method,
    );
  });

/** `Github.markReady` handler — flip the session's draft PR to ready for review. */
export const githubMarkReady = (input: { sessionId: string }) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId);
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(
        new GitHubApiError({
          reason: "validation",
          message: "No linked pull request to mark ready",
        }),
      );
    }
    yield* GitHubApi.prReady(session.worktreePath, session.prNumber);
  });

/** `Github.updateBranch` handler — merge the base into the PR's head on GitHub. */
export const githubUpdateBranch = (input: { sessionId: string }) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId);
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(
        new GitHubApiError({
          reason: "validation",
          message: "No linked pull request to update",
        }),
      );
    }
    yield* GitHubApi.prUpdateBranch(session.worktreePath, session.prNumber);
  });

/**
 * `Terminal.create` handler. Resolves the terminal's working directory: an
 * explicit `cwd` wins, else the session's worktree, else the main-process cwd
 * (the service's own fallback). Keeping the resolution here means the renderer
 * can stay oblivious to worktree paths. Exported for tests.
 */
export const createTerminal = (input: {
  sessionId: string;
  cwd?: string;
  cols: number;
  rows: number;
}) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(input.sessionId).pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
    const cwd = input.cwd ?? session?.worktreePath ?? undefined;
    const terminals = yield* TerminalService;
    if (session?.checkpointSafeMode) return yield* Effect.fail(new TerminalError({ message: "Interactive terminals are unsupported in checkpoint-safe mode." }));
    if (session) yield* SessionStore.markCheckpointTerminalExecutionUnprovable(session.id).pipe(Effect.mapError((cause) => new TerminalError({ message: "Could not persist terminal history; terminal creation blocked.", cause })));
    return yield* terminals.create({
      executionHistoryPersisted: session !== null && session !== undefined,
      unscoped: session === null || session === undefined,
      sessionId: input.sessionId,
      workspaceEnvironment: session ? workspaceEnvironment(session) : {},
      cwd,
      cols: input.cols,
      rows: input.rows,
    });
  });

/**
 * Persist a per-session reasoning override without making the composer's
 * optimistic control wait on disk. The RPC remains best-effort, but a failed
 * sessions.json write must be visible in the main-process log: otherwise the
 * selection appears to work until the next restart and leaves no diagnosis.
 */
export const setReasoning = (
  sessionId: string,
  chatId: string,
  reasoning: Parameters<typeof SessionStore.setReasoning>[2],
) =>
  SessionStore.setReasoning(sessionId, chatId, reasoning).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(
        `Failed to persist reasoning strength for session ${sessionId}: ${error.message}`,
      ),
    ),
    Effect.ignore,
  );

/**
 * Resolve a plugin id against the live catalog.
 *
 * Every host operation starts here rather than trusting the id it was handed:
 * the renderer can ask to invoke a command in a plugin that was uninstalled a
 * moment ago, and "no such plugin" is a better answer than a process being
 * asked to activate a directory that is gone.
 *
 * ## Why the catalog is cached
 *
 * `PluginRegistry.list()` stats, reads and Schema-decodes every manifest on
 * disk. Doing that on EVERY `Plugins.invoke` put a full directory scan in front
 * of every command a plugin's UI fires — including ones in a render loop.
 *
 * The cache is invalidated by the watcher, which already re-emits the whole
 * catalog whenever `~/jingler/plugins` changes, so the only way to read a stale
 * entry is to race a filesystem change by less than the debounce — and the
 * activation that follows re-reads the directory anyway.
 */
let catalogCache: { at: number; catalog: PluginCatalog } | null = null;

/** How long a resolved catalog is trusted between filesystem events. */
const CATALOG_CACHE_MS = 2_000;

/** Dropped by the watcher, so an install or uninstall is visible immediately. */
export const invalidatePluginCatalog = (): void => {
  catalogCache = null;
};

const cachedCatalog = Effect.suspend(() => {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < CATALOG_CACHE_MS) {
    return Effect.succeed(catalogCache.catalog);
  }
  return Effect.tap(PluginRegistry.list(), (catalog) =>
    Effect.sync(() => {
      catalogCache = { at: now, catalog };
    }),
  );
});

/**
 * Tear down a plugin's host half, tolerating every reason there might not be one.
 *
 * Disable and uninstall both need this and neither should fail because of it: a
 * UI-only plugin has no host half, a never-activated plugin has nothing running,
 * and a build without an extension host has no runtime at all. All three are
 * normal, and none of them is a reason to refuse to disable something.
 *
 * `deactivate` on the runtime is already a no-op for a plugin it is not running,
 * so this only has to absorb the "no host here" failure from `get()`.
 */
const deactivateQuietly = (pluginId: string) =>
  PluginHost.get().pipe(
    Effect.flatMap((host) => Effect.promise(() => host.deactivate(pluginId))),
    Effect.catchAll(() => Effect.void),
  );

const installedPluginById = (pluginId: string) =>
  Effect.flatMap(cachedCatalog, (catalog) => {
    const found = catalog.plugins.find((p) => p.manifest.id === pluginId);
    if (!found) {
      return Effect.fail(
        new PluginError({
          pluginId,
          reason: `no plugin with id "${pluginId}" is installed`,
        }),
      );
    }
    return Effect.succeed(found);
  });

const enabledPluginById = (pluginId: string) =>
  Effect.flatMap(installedPluginById(pluginId), (plugin) => {
    if (!plugin.enabled) {
      // A disabled plugin runs no code, and that has to include commands the
      // renderer still remembers — otherwise the Settings switch is advisory.
      return Effect.fail(
        new PluginError({ pluginId, reason: `"${pluginId}" is disabled` }),
      );
    }
    return Effect.succeed(plugin);
  });

const declaredSetting = (pluginId: string, settingId: string) =>
  Effect.flatMap(installedPluginById(pluginId), (plugin) => {
    const setting = (plugin.manifest.contributes?.settings ?? []).find(
      (candidate) => candidate.id === settingId,
    );
    return setting
      ? Effect.succeed(setting)
      : Effect.fail(
          new PluginError({
            pluginId,
            reason: `"${settingId}" is not a setting declared by this plugin`,
          }),
        );
  });

const declaredSecretProfile = (pluginId: string, collectionId: string) =>
  Effect.flatMap(installedPluginById(pluginId), (plugin) => {
    const profile = (plugin.manifest.contributes?.secretProfiles ?? []).find(
      (candidate) => candidate.id === collectionId,
    );
    return profile
      ? Effect.succeed(profile)
      : Effect.fail(
          new PluginError({
            pluginId,
            reason: `"${collectionId}" is not a secret profile collection declared by this plugin`,
          }),
        );
  });

const declaredSecretSetting = (pluginId: string, settingId: string) =>
  Effect.flatMap(declaredSetting(pluginId, settingId), (setting) =>
    setting.type === "secret"
      ? Effect.succeed(setting)
      : Effect.fail(
          new PluginError({
            pluginId,
            reason: `"${settingId}" is not a secret setting`,
          }),
        ),
  );

/** Reserved inside ordinary plugin storage; plugin UI may read it, never secrets. */
const PLUGIN_SETTING_STORAGE_PREFIX = "$settings/";
const pluginSettingStorageKey = (settingId: string) =>
  `${PLUGIN_SETTING_STORAGE_PREFIX}${settingId}`;

const settingValidationFailure = (
  setting: SettingContribution,
  value: unknown,
): string | null => {
  const wrongType =
    (setting.type === "number" && typeof value !== "number") ||
    (setting.type === "boolean" && typeof value !== "boolean") ||
    ((setting.type === "string" ||
      setting.type === "enum" ||
      setting.type === "secret") &&
      typeof value !== "string");
  if (wrongType) return `"${setting.id}" expects a ${setting.type} value`;

  if (
    setting.type === "enum" &&
    typeof value === "string" &&
    setting.options !== undefined &&
    !setting.options.includes(value)
  ) {
    return `"${setting.id}" must be one of its declared options`;
  }

  if (
    setting.validation &&
    typeof value === "string" &&
    !new RegExp(setting.validation.pattern).test(value)
  ) {
    return setting.validation.message ?? `"${setting.id}" has an invalid value`;
  }
  return null;
};

const validPersistedSettingValue = (
  setting: SettingContribution,
  value: unknown,
): value is PluginSettingValue =>
  setting.type !== "secret" &&
  settingValidationFailure(setting, value) === null;

/** Where one plugin's private key/value blob lives. Confined by construction. */
const pluginStorageFile = (pluginId: string) =>
  Effect.gen(function* () {
    const paths = yield* AppPaths;
    const path = yield* Path.Path;
    const root = path.resolve(paths.pluginStorageDir);
    const file = path.resolve(root, `${pluginId}.json`);
    // The id is schema-constrained to kebab-case at the contract boundary, so
    // this can only fail if that guarantee is ever relaxed. Cheap to keep, and
    // the failure mode it prevents is writing anywhere on disk.
    if (path.dirname(file) !== root) {
      return yield* Effect.fail(
        new PluginError({
          pluginId,
          reason: "plugin id escapes the storage directory",
        }),
      );
    }
    return { root, file };
  });

const pluginStorageRead = (pluginId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { file } = yield* pluginStorageFile(pluginId);
    const raw = yield* fs
      .readFileString(file)
      .pipe(Effect.orElseSucceed(() => null));
    if (!raw) return {} as Record<string, unknown>;
    return yield* Effect.try(
      () => JSON.parse(raw) as Record<string, unknown>,
    ).pipe(
      // A corrupt blob reads as empty rather than failing every subsequent get.
      // Plugin storage is a cache of the plugin's own state, not a record of
      // record — losing it costs a re-fetch, whereas a hard failure here would
      // wedge the plugin with no way for the operator to clear it.
      Effect.orElseSucceed(() => ({}) as Record<string, unknown>),
    );
  });

/**
 * Read one key. Declared never-failing in the contract, so every fault folds to
 * `null` — an unreadable store is indistinguishable from an unset key, which is
 * exactly what a caller asking "do you have this?" wants.
 */
export const pluginStorageGet = (pluginId: string, key: string) =>
  pluginStorageRead(pluginId).pipe(
    Effect.map((all) => all[key] ?? null),
    Effect.orElseSucceed(() => null),
  );

/**
 * One writer at a time, per plugin.
 *
 * `set` and `delete` are each read-modify-write over a whole JSON blob. Two
 * concurrent writers — a plugin's UI half and its host half both persisting, or
 * two `set`s inside one `Promise.all` — each read the same before-state, and the
 * second write silently dropped the first's key.
 *
 * A permit per plugin id rather than one global: two plugins writing at once are
 * touching different files and have no reason to queue behind each other.
 */
const storageLocks = new Map<string, Effect.Semaphore>();

const withStorageLock = <A, E, R>(
  pluginId: string,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Effect.sync(() => {
      const existing = storageLocks.get(pluginId);
      if (existing) return existing;
      const created = Effect.unsafeMakeSemaphore(1);
      storageLocks.set(pluginId, created);
      return created;
    }),
    (lock) => lock.withPermits(1)(work),
  );

/** Write the whole blob back. Shared by set and delete. */
const pluginStorageWrite = (pluginId: string, all: Record<string, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root, file } = yield* pluginStorageFile(pluginId);
    yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.ignore);
    yield* fs.writeFileString(file, JSON.stringify(all, null, 2)).pipe(
      Effect.mapError(
        (cause) =>
          new PluginError({
            pluginId,
            reason: "could not write plugin storage",
            cause,
          }),
      ),
    );
  });

export const pluginStorageSet = (
  pluginId: string,
  key: string,
  value: unknown,
) =>
  withStorageLock(
    pluginId,
    Effect.flatMap(pluginStorageRead(pluginId), (all) =>
      pluginStorageWrite(pluginId, { ...all, [key]: value }),
    ),
  );

/**
 * Remove a key.
 *
 * Not `set(key, null)`: a key present with a null value still appears in
 * `storageKeys`, so folding the two together would make a deleted key show up
 * in a listing forever.
 */
const pluginStorageDeleteUnlocked = (pluginId: string, key: string) =>
  Effect.flatMap(pluginStorageRead(pluginId), (all) => {
    if (!(key in all)) return Effect.void;
    const { [key]: _removed, ...rest } = all;
    return pluginStorageWrite(pluginId, rest);
  });

export const pluginStorageDelete = (pluginId: string, key: string) =>
  withStorageLock(pluginId, pluginStorageDeleteUnlocked(pluginId, key));

/** Declared never-failing: an unreadable store lists nothing, same as an empty one. */
export const pluginStorageKeys = (pluginId: string) =>
  pluginStorageRead(pluginId).pipe(
    Effect.map((all) => Object.keys(all)),
    Effect.orElseSucceed(() => [] as Array<string>),
  );

/** Remove generated ordinary settings while preserving unrelated plugin data. */
const clearPluginSettings = (pluginId: string) =>
  withStorageLock(
    pluginId,
    Effect.flatMap(pluginStorageRead(pluginId), (all) => {
      const remaining = Object.fromEntries(
        Object.entries(all).filter(
          ([key]) => !key.startsWith(PLUGIN_SETTING_STORAGE_PREFIX),
        ),
      );
      return Object.keys(remaining).length === Object.keys(all).length
        ? Effect.void
        : pluginStorageWrite(pluginId, remaining);
    }),
  );

const pluginSettingsGet = (pluginId: string) =>
  Effect.gen(function* () {
    const plugin = yield* installedPluginById(pluginId);
    const settings = plugin.manifest.contributes?.settings ?? [];
    const pluginSecrets = yield* PluginSecretStore;

    const values = yield* Effect.forEach(
      settings.filter((setting) => setting.type !== "secret"),
      (setting) =>
        Effect.map(
          pluginStorageGet(pluginId, pluginSettingStorageKey(setting.id)),
          (stored): readonly [string, PluginSettingValue | null] => {
            if (validPersistedSettingValue(setting, stored)) {
              return [setting.id, stored];
            }
            return validPersistedSettingValue(setting, setting.default)
              ? [setting.id, setting.default]
              : [setting.id, null];
          },
        ),
      { concurrency: "unbounded" },
    );
    const secrets = yield* Effect.forEach(
      settings.filter((setting) => setting.type === "secret"),
      (setting) =>
        Effect.map(
          pluginSecrets.status(pluginId, setting.id),
          (configured): readonly [string, boolean] => [setting.id, configured],
        ),
      { concurrency: "unbounded" },
    );

    return {
      values: Object.fromEntries(values),
      secrets: Object.fromEntries(secrets),
    } satisfies PluginSettingsSnapshot;
  });

const pluginSettingSet = (
  pluginId: string,
  settingId: string,
  value: PluginSettingValue,
) =>
  Effect.gen(function* () {
    const setting = yield* declaredSetting(pluginId, settingId);
    if (setting.type === "secret") {
      return yield* Effect.fail(
        new PluginError({
          pluginId,
          reason: `"${settingId}" is secret and must be saved through secure settings`,
        }),
      );
    }
    const failure = settingValidationFailure(setting, value);
    if (failure) {
      return yield* Effect.fail(new PluginError({ pluginId, reason: failure }));
    }
    yield* pluginStorageSet(
      pluginId,
      pluginSettingStorageKey(settingId),
      value,
    );
  });

const mapPluginSecretStoreError =
  (pluginId: string, reason: (cause: PluginSecretStoreUnavailable) => string) =>
  <A, R>(effect: Effect.Effect<A, PluginSecretStoreUnavailable, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) => new PluginError({ pluginId, reason: reason(cause), cause }),
      ),
    );

const pluginSecretSet = (pluginId: string, settingId: string, value: string) =>
  Effect.gen(function* () {
    const setting = yield* declaredSecretSetting(pluginId, settingId);
    if (value.length === 0) {
      return yield* Effect.fail(
        new PluginError({
          pluginId,
          reason: `"${settingId}" cannot be empty; use Remove to clear it`,
        }),
      );
    }
    const failure = settingValidationFailure(setting, value);
    if (failure) {
      return yield* Effect.fail(new PluginError({ pluginId, reason: failure }));
    }
    const pluginSecrets = yield* PluginSecretStore;
    yield* pluginSecrets
      .set(pluginId, settingId, value)
      .pipe(
        mapPluginSecretStoreError(
          pluginId,
          (cause) =>
            `Could not save "${setting.label}" securely: ${cause.message}`,
        ),
      );
  });

const pluginSecretClear = (pluginId: string, settingId: string) =>
  Effect.gen(function* () {
    const setting = yield* declaredSecretSetting(pluginId, settingId);
    const pluginSecrets = yield* PluginSecretStore;
    yield* pluginSecrets
      .clear(pluginId, settingId)
      .pipe(
        mapPluginSecretStoreError(
          pluginId,
          (cause) => `Could not remove "${setting.label}": ${cause.message}`,
        ),
      );
  });

/**
 * Host-only secret read. The caller supplies the plugin id from its bound host
 * context; this repeats manifest validation before touching the secret store so
 * a plugin cannot use the supported API to read another plugin's namespace or
 * an undeclared key.
 */
export const pluginSecretGetForHost = (pluginId: string, settingId: string) =>
  Effect.gen(function* () {
    yield* declaredSecretSetting(pluginId, settingId);
    const pluginSecrets = yield* PluginSecretStore;
    return yield* pluginSecrets.get(pluginId, settingId);
  });

const profileSecretKey = (collectionId: string, profileId: string) =>
  `$profiles/${collectionId}/${profileId}`;

export const pluginProfileSecretGetForHost = (
  pluginId: string,
  collectionId: string,
  profileId: string,
) =>
  Effect.gen(function* () {
    yield* declaredSecretProfile(pluginId, collectionId);
    const pluginSecrets = yield* PluginSecretStore;
    return yield* pluginSecrets.get(pluginId, profileSecretKey(collectionId, profileId));
  });

export const pluginProfileSecretSetForHost = (
  pluginId: string,
  collectionId: string,
  profileId: string,
  value: string,
) =>
  Effect.gen(function* () {
    const profile = yield* declaredSecretProfile(pluginId, collectionId);
    if (!value) return yield* Effect.fail(new PluginError({ pluginId, reason: "Secret profile values cannot be empty" }));
    const pluginSecrets = yield* PluginSecretStore;
    yield* pluginSecrets.set(pluginId, profileSecretKey(collectionId, profileId), value).pipe(
      mapPluginSecretStoreError(pluginId, (cause) => `Could not save "${profile.label}" securely: ${cause.message}`),
    );
  });

export const pluginProfileSecretDeleteForHost = (
  pluginId: string,
  collectionId: string,
  profileId: string,
) =>
  Effect.gen(function* () {
    const profile = yield* declaredSecretProfile(pluginId, collectionId);
    const pluginSecrets = yield* PluginSecretStore;
    yield* pluginSecrets.clear(pluginId, profileSecretKey(collectionId, profileId)).pipe(
      mapPluginSecretStoreError(pluginId, (cause) => `Could not remove "${profile.label}": ${cause.message}`),
    );
  });

const clearPluginConfiguration = (pluginId: string) =>
  Effect.gen(function* () {
    yield* clearPluginSettings(pluginId).pipe(
      Effect.mapError(
        (cause) =>
          new PluginError({
            pluginId,
            reason: `The plugin remains installed because its ordinary settings could not be cleared: ${cause.reason}`,
            cause,
          }),
      ),
    );
    const pluginSecrets = yield* PluginSecretStore;
    yield* pluginSecrets
      .clearPlugin(pluginId)
      .pipe(
        mapPluginSecretStoreError(
          pluginId,
          (cause) =>
            `The plugin remains installed because its encrypted settings could not be cleared: ${cause.message}`,
        ),
      );
  });

export const uninstallPlugin = (pluginId: string) =>
  Effect.gen(function* () {
    // Validate the target without mutating it. Cleanup must not revoke a
    // bundled plugin's credentials only to have the registry refuse deletion.
    const paths = yield* AppPaths;
    const pluginDir = yield* PluginRegistry.dirFor(pluginId);
    if (dirname(resolve(pluginDir)) !== resolve(paths.pluginsDir)) {
      return yield* Effect.fail(
        new PluginError({
          pluginId,
          reason:
            "That plugin ships with Jingler and cannot be uninstalled. Disable it instead.",
        }),
      );
    }
    // Stop it BEFORE touching credentials or its directory. A host half whose
    // `deactivate` touches its own files should still find them there.
    yield* deactivateQuietly(pluginId);
    yield* PluginAuth.revokeAll(pluginId).pipe(
      Effect.mapError(
        (cause) =>
          new PluginError({
            pluginId,
            reason: `The plugin remains installed because its authorization grants could not be revoked: ${cause.reason}`,
            cause,
          }),
      ),
    );
    yield* clearPluginConfiguration(pluginId);
    // Directory removal is deliberately last. If credential cleanup fails,
    // the plugin stays visible in Settings so the operator can retry rather
    // than leaving secrets orphaned behind an uninstalled plugin id.
    yield* PluginRegistry.uninstall(pluginId);
  });

const pluginHostOperation = <A>(
  pluginId: string,
  run: (host: PluginHostRuntime, plugin: LoadedPlugin) => Promise<A>,
) =>
  Effect.gen(function* () {
    const host = yield* PluginHost.get();
    const plugin = yield* enabledPluginById(pluginId);
    return yield* Effect.tryPromise({
      try: () => run(host, plugin),
      catch: (cause) =>
        cause instanceof PluginError
          ? cause
          : new PluginError({ pluginId, reason: String(cause) }),
    });
  });

const issueProviderDescriptors = () =>
  Effect.map(cachedCatalog, (catalog) =>
    catalog.plugins
      .filter((plugin) => plugin.enabled && plugin.manifest.main !== undefined)
      .flatMap((plugin) =>
        (plugin.manifest.contributes?.issueProviders ?? []).map((provider) => ({
          pluginId: plugin.manifest.id,
          id: provider.id,
          label: provider.label,
        })),
      ),
  );

const enabledIssueProvider = (providerId: string) =>
  Effect.flatMap(cachedCatalog, (catalog) => {
    const matches = catalog.plugins.flatMap((plugin) =>
      plugin.enabled && plugin.manifest.main !== undefined
        ? (plugin.manifest.contributes?.issueProviders ?? [])
            .filter((provider) => provider.id === providerId)
            .map((provider) => ({ plugin, provider }))
        : [],
    );
    if (matches.length === 1) return Effect.succeed(matches[0]!);
    return Effect.fail(
      new PluginError({
        pluginId: matches[0]?.plugin.manifest.id ?? "<issue-provider>",
        reason:
          matches.length === 0
            ? `no enabled issue provider with id "${providerId}" is installed`
            : `more than one enabled plugin declares the issue provider "${providerId}"`,
      }),
    );
  });

/** Return the first provider identity that does not belong to the routed provider. */
export const mismatchedIssueProviderId = (
  providerId: string,
  returnedProviderIds: ReadonlyArray<string>,
): string | undefined => returnedProviderIds.find((id) => id !== providerId);

const issueProviderOperation = <A, I>(
  providerId: string,
  method: "listIssues" | "getIssue" | "createIssue" | "addComment",
  input: unknown,
  schema: Schema.Schema<A, I>,
  providerIdsOf?: (value: A) => ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const { plugin } = yield* enabledIssueProvider(providerId);
    const raw = yield* pluginHostOperation(plugin.manifest.id, (host, loaded) =>
      host.invokeIssueProvider(loaded, providerId, method, input),
    );
    const decoded = yield* Schema.decodeUnknown(schema)(raw).pipe(
      Effect.mapError(
        (cause) =>
          new PluginError({
            pluginId: plugin.manifest.id,
            reason: `issue provider "${providerId}" returned invalid normalized data: ${String(cause)}`,
          }),
      ),
    );
    const mismatched = mismatchedIssueProviderId(
      providerId,
      providerIdsOf?.(decoded) ?? [],
    );
    if (mismatched) {
      return yield* Effect.fail(
        new PluginError({
          pluginId: plugin.manifest.id,
          reason: `issue provider "${providerId}" returned data owned by "${mismatched}"`,
        }),
      );
    }
    return decoded;
  });

/** Handlers for every procedure in the group, delegated to Effect services. */
let failGitHubFeedbackMarkOnce =
  process.env.JINGLER_E2E_GITHUB_FAIL_MARK_ONCE === "1";

export const listProjectDirectories = (requestedPath?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.resolve(requestedPath ?? homedir());
    const info = yield* fs.stat(directory);
    if (info.type !== "Directory") {
      return yield* Effect.fail(
        new GitError({ message: `Not a directory: ${directory}` }),
      );
    }
    const names = yield* fs.readDirectory(directory);
    const candidates = yield* Effect.forEach(
      names.filter((name) => !name.startsWith(".")),
      (name) =>
        Effect.gen(function* () {
          const child = path.join(directory, name);
          const childInfo = yield* fs.stat(child).pipe(Effect.option);
          if (
            Option.isNone(childInfo) ||
            childInfo.value.type !== "Directory"
          ) {
            return null;
          }
          const isGitRepository = yield* fs
            .exists(path.join(child, ".git"))
            .pipe(Effect.orElseSucceed(() => false));
          return { name, path: child, isGitRepository };
        }),
      { concurrency: 16 },
    );
    const parent = path.dirname(directory);
    return {
      path: directory,
      parentPath: parent === directory ? null : parent,
      directories: candidates
        .filter((candidate) => candidate !== null)
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof GitError
        ? cause
        : new GitError({ message: "Could not read that directory", cause }),
    ),
  );

const providerOperation = <A, E extends { readonly message: string }>(
  operation: (service: ProviderConnectionsShape) => Effect.Effect<A, E>,
): Effect.Effect<A, ProviderConnectionError, ProviderConnections> =>
  Effect.flatMap(ProviderConnections, operation).pipe(
    Effect.mapError(
      (error) => new ProviderConnectionError({ message: error.message }),
    ),
  );

const nativeEndpointLogin = (input: { endpointId: string; targetId: string; loginId?: string }, cancel = false) =>
  Effect.gen(function* () {
    if (input.targetId === "desktop") {
      return yield* Effect.tryPromise({
        try: () => cancel
          ? codexEndpointLogin.cancel(input.endpointId, input.targetId, input.loginId ?? "").then(() => undefined)
          : codexEndpointLogin.start(input.endpointId, input.targetId),
        catch: () => new ProviderConnectionError({ message: "Native Codex login failed" })
      })
    }
    const environments = yield* EnvironmentService
    const targets = yield* environments.list
    const target = targets.find((entry) => entry.kind === "owned" && entry.capabilities?.runtime?.targetId === input.targetId)
    if (!target) return yield* Effect.fail(new ProviderConnectionError({ message: "Native login target is unavailable" }))
    const response = yield* environments.discovery(target.id, {
      ...input, action: cancel ? "login-cancel" : "login-start"
    })
    if (response.loginError || (!cancel && !response.login))
      return yield* Effect.fail(new ProviderConnectionError({ message: response.loginError ?? "Native login returned no device code" }))
    return response.login
  }).pipe(Effect.mapError((cause) => new ProviderConnectionError({ message: cause.message })))

const localAgentEndpointCatalog = (refresh: boolean) =>
  Effect.gen(function* () {
    const providers = yield* ProviderConnections
    const providerCatalog = yield* (refresh
      ? providers.refreshCatalog
      : providers.list).pipe(
        Effect.mapError((cause) => new ProviderConnectionError({ message: cause.message }))
      )
    const claude = yield* Effect.tryPromise({
      try: () => probeClaudeEndpoint({ targetId: "desktop" }),
      catch: (cause) => new ProviderConnectionError({
        message: cause instanceof Error ? cause.message : "Claude CLI probe failed"
      })
    })
    const pi = projectPiEndpointCatalog(providerCatalog)
    return {
      refreshedAt: new Date().toISOString(),
      stale: pi.stale,
      endpoints: [...pi.endpoints.slice(0, 61), claude, yield* Effect.promise(() => probeCodexEndpoint({ targetId: "desktop" })), yield* Effect.promise(() => probeOpenCodeEndpoint({ targetId: "desktop" }))]
    }
  })

const agentResourceError = (
  operation: AgentResourceRpcError["operation"],
  cause: { readonly message: string },
) => new AgentResourceRpcError({ operation, message: cause.message });

/**
 * Resolve migrated sessions still gated on "choose a runtime connection" the
 * moment an authenticated connection can satisfy them. Best-effort by design:
 * a failure leaves the gate up (the manual path still works) rather than
 * failing the listing that carries every other session.
 */
const healMigratedRuntimeIdentities = Effect.gen(function* () {
  const sessions = yield* SessionStore.list();
  const gated = sessions.filter(sessionNeedsRuntimeIdentity);
  if (gated.length === 0) return;
  const catalog = yield* ProviderConnections.pipe(
    Effect.flatMap((service) => service.list),
  );
  const config = yield* ConfigService.get().pipe(
    Effect.orElseSucceed(() => null),
  );
  const defaults = {
    connectionId: config?.defaultConnectionId ?? null,
    modelId: config?.defaultModelId ?? null,
  };
  for (const session of gated) {
    for (const adopted of adoptableChatIdentities(session, catalog, defaults)) {
      yield* SessionStore.setProviderModel(
        session.id,
        adopted.chatId,
        adopted.connectionId,
        adopted.providerId,
        adopted.modelId,
      );
    }
  }
}).pipe(Effect.catchAll(() => Effect.void));

const resourceWorktree = (sessionId: string | null) =>
  sessionId === null
    ? Effect.succeed(null)
    : SessionStore.get(sessionId).pipe(
        Effect.map((session) => session.worktreePath ?? null),
        Effect.orElseSucceed(() => null),
      );

const resourceDetection = (sessionId: string | null) =>
  resourceWorktree(sessionId).pipe(
    Effect.flatMap((worktreePath) =>
      detectAgentResources({ homeDir: homedir(), worktreePath }),
    ),
  );

const resourceList = Effect.flatMap(AgentResourceService, (files) => files.list)
  .pipe(Effect.mapError((cause) => agentResourceError("list", cause)));

const resourceEnabledForTarget = (targetId: string) =>
  Effect.flatMap(AgentResourceService, (files) => files.enabledForTarget(targetId))
    .pipe(Effect.mapError((cause) => agentResourceError("resolve", cause)));

const webSearchSettingsStatus = Effect.gen(function* () {
  const config = yield* ConfigService.get().pipe(
    Effect.mapError(() => new WebSearchError({
      reason: "unavailable",
      message: "Could not read WebSearch settings",
      retryable: true,
    })),
  );
  const credentials = yield* WebSearchCredentialService.status;
  return {
    config: config?.webSearch ?? WEB_SEARCH_CONFIG_DEFAULT,
    credentials,
  };
});

export const updateWebSearchAtomically = <A, E, R>(
  next: WebSearchConfig,
  mutateCredential: Effect.Effect<A, E, R>,
) => Effect.gen(function* () {
  const current = yield* ConfigService.get().pipe(
    Effect.map((config) => config?.webSearch ?? WEB_SEARCH_CONFIG_DEFAULT),
    Effect.mapError(() => new WebSearchError({
      reason: "unavailable",
      message: "Could not read WebSearch settings before updating credentials",
      retryable: true,
    })),
  );
  yield* ConfigService.setWebSearch(next).pipe(
    Effect.mapError(() => new WebSearchError({
      reason: "unavailable",
      message: "Could not save WebSearch settings",
      retryable: true,
    })),
  );
  return yield* mutateCredential.pipe(
    Effect.catchAll((cause) =>
      ConfigService.setWebSearch(current).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.zipRight(Effect.fail(cause)),
      ),
    ),
  );
});

const CoreHandlersLayer = JinglerCoreRpcs.toLayer({
  "RuntimeDiagnostics.get": ({ runId }) => RuntimeDiagnostics.get(runId),
  "RuntimeDiagnostics.latest": () => RuntimeDiagnostics.latest(),
  "RuntimeDiagnostics.export": ({ runId }) => RuntimeDiagnostics.export(runId),
  "AgentEndpoint.list": () => localAgentEndpointCatalog(false),
  "AgentEndpoint.refresh": () => localAgentEndpointCatalog(true),
  "AgentEndpoint.startLogin": (input) => nativeEndpointLogin(input).pipe(Effect.flatMap((login) =>
    login ? Effect.succeed(login) : Effect.fail(new ProviderConnectionError({ message: "Native login returned no device code" })))),
  "AgentEndpoint.cancelLogin": (input) => nativeEndpointLogin(input, true).pipe(Effect.asVoid),
  "AgentEndpoint.setModel": (input) => Effect.gen(function* () {
    const { sessionId, chatId, runtimeId, endpointId, providerId, modelId } = input
    const session = yield* SessionStore.get(sessionId)
    const endpointCatalog = session.environmentId === undefined
      ? yield* localAgentEndpointCatalog(false)
      : (yield* EnvironmentService.environment(session.environmentId).pipe(
          Effect.mapError((cause) => new ProviderConnectionError({ message: cause.message }))
        )).capabilities?.endpointCatalog
    const selectable = endpointCatalog?.endpoints.some(({ endpoint, models }) =>
      endpoint.id === endpointId &&
      endpoint.runtimeId === runtimeId &&
      endpoint.status === "ready" &&
      models.some((model) =>
        model.providerId === providerId && model.id === modelId && model.selectable
      )
    ) === true
    if (!selectable) {
      return yield* Effect.fail(new ProviderConnectionError({
        message: "Agent endpoint model is unavailable"
      }))
    }
    if (session.environmentId !== undefined) {
      const remote = yield* RemoteSessionService
      const value = yield* remote.request(session, "AgentEndpoint.setModel", input).pipe(
        Effect.mapError((cause) => new ProviderConnectionError({ message: cause.message }))
      )
      const updated = yield* Schema.decodeUnknown(SessionSchema)(value).pipe(
        Effect.mapError((cause) => new ProviderConnectionError({ message: `The remote device returned invalid session metadata: ${String(cause)}` }))
      )
      if (updated.id !== sessionId || updated.environmentId !== session.environmentId) {
        return yield* Effect.fail(new ProviderConnectionError({ message: "The remote device returned model state for another session" }))
      }
      return yield* SessionStore.upsertRemote(updated)
    }
    if (runtimeId !== "pi") {
      yield* SessionStore.setAgentModel(
        sessionId,
        chatId,
        runtimeId,
        endpointId,
        providerId,
        modelId
      )
      return yield* SessionStore.get(sessionId)
    }
    const providers = yield* ProviderConnections
    const catalog = yield* providers.list.pipe(
      Effect.mapError((cause) => new ProviderConnectionError({ message: cause.message }))
    )
    const entry = catalog.connections.find(({ connection, models }) =>
      piEndpointId(connection.targetId, connection.id) === endpointId &&
      models.some((model) =>
        model.providerId === providerId && model.id === modelId && model.selectable
      )
    )
    if (entry === undefined) {
      return yield* Effect.fail(new ProviderConnectionError({
        message: "Agent endpoint model is unavailable"
      }))
    }
    const runner = yield* AgentRunner
    // The write queues behind the chat lock, which a turn holds while it sets
    // up or unwinds. Waiting forever there left the composer stuck on "Saving
    // the selected agent runtime…" with no way out; give up and say why.
    // Interrupting before the permit is granted writes nothing.
    return yield* runner.setModel(
      sessionId,
      chatId,
      entry.connection.id,
      providerId,
      modelId
    ).pipe(
      Effect.timeoutFail({
        duration: Duration.seconds(10),
        onTimeout: () => new ProviderConnectionError({
          message: "This chat is still starting or stopping a turn. Try switching models again in a moment."
        })
      })
    )
  }),
  "Provider.list": () => providerOperation((service) => service.list),
  "Provider.status": () => providerOperation((service) => service.status),
  "Provider.loginEvents": () =>
    interruptOnPageGone(
      Stream.unwrap(
        ProviderConnections.pipe(Effect.map((service) => service.loginEvents)),
      ),
    ),
  "Provider.connectClaudeToken": (input) =>
    providerOperation((service) => service.connectClaudeToken(input)),
  "Provider.startCodexLogin": (input) =>
    providerOperation((service) => service.startCodexLogin(input)),
  "Provider.cancelLogin": ({ connectionId }) =>
    providerOperation((service) => service.cancelLogin(connectionId)),
  "Provider.setApiKey": (input) =>
    providerOperation((service) => service.setApiKey(input)),
  "Provider.refresh": ({ connectionId }) =>
    providerOperation((service) => service.refresh(connectionId)),
  "Provider.logout": ({ connectionId }) =>
    providerOperation((service) => service.logout(connectionId)),
  "Provider.removeConnection": ({ connectionId }) =>
    providerOperation((service) => service.remove(connectionId)),
  "Provider.verifyModel": (input) =>
    providerOperation((service) => service.verifyModel(input)),
  "AgentResources.list": () => resourceList,
  "AgentResources.detect": ({ sessionId }) => resourceDetection(sessionId),
  "AgentResources.importFiles": ({ sessionId, sourcePaths, scope }) =>
    Effect.gen(function* () {
      const service = yield* AgentResourceService;
      const detected = yield* resourceDetection(sessionId);
      const requested = new Set(sourcePaths);
      const candidates = detected.candidates.filter((candidate) =>
        requested.has(candidate.provenance.sourcePath),
      );
      const imported = yield* service.importResources(candidates, scope);
      const found = new Set(
        candidates.map((candidate) => candidate.provenance.sourcePath),
      );
      return {
        imported: imported.imported,
        skipped: [
          ...imported.skipped,
          ...sourcePaths
            .filter((sourcePath) => !found.has(sourcePath))
            .map((sourcePath) => ({
              sourcePath,
              kind: null,
              code: "malformed" as const,
              message: "Resource is no longer present in the detected catalog",
            })),
        ],
      };
    }).pipe(Effect.mapError((cause) => agentResourceError("import", cause))),
  "AgentResources.remove": ({ id }) =>
    Effect.flatMap(AgentResourceService, (files) => files.remove(id)).pipe(
      Effect.mapError((cause) => agentResourceError("remove", cause)),
    ),
  "AgentResources.setEnabled": ({ id, enabled }) =>
    Effect.flatMap(AgentResourceService, (files) => files.setEnabled(id, enabled)).pipe(
      Effect.mapError((cause) => agentResourceError("enable", cause)),
    ),
  "AgentResources.reveal": ({ id }) =>
    Effect.flatMap(AgentResourceService, (service) => service.reveal(id)).pipe(
      Effect.tap((path) => Effect.sync(() => shell.showItemInFolder(path))),
      Effect.asVoid,
      Effect.mapError((cause) => agentResourceError("reveal", cause)),
      ),
  "AgentResources.enabledForTarget": ({ targetId }) =>
    resourceEnabledForTarget(targetId),
  "AgentResources.watch": () =>
    interruptOnPageGone(
      Stream.unwrap(
        Effect.map(AgentResourceService, (service) => service.watch()),
      ).pipe(
        Stream.mapEffect(() => resourceList),
        Stream.catchAll(() => Stream.empty),
      ),
    ),
  "Environment.list": () => EnvironmentService.list,
  "Environment.refresh": () => EnvironmentService.refresh,
  "Environment.discovery": ({ deviceId, endpointRequest }) =>
    EnvironmentService.discovery(deviceId, endpointRequest),
  // Presence polling is long-lived. A token refresh or brief relay outage
  // pauses updates rather than permanently terminating the subscription: a
  // failed poll is skipped (not retried in place — the old uncapped
  // exponential retry backed off past hours and effectively killed the
  // subscription) and the next tick simply comes later. A dev box with no
  // device auth settles into one cheap 401 per minute instead of a retry
  // storm, and `changesWith` keeps unchanged lists off the IPC channel
  // entirely — with zero devices the steady-state cost is zero frames.
  "Environment.watch": () =>
    interruptOnPageGone(
      Stream.repeatEffectWithSchedule(
        EnvironmentService.list.pipe(Effect.option),
        Schedule.identity<
          Option.Option<Effect.Effect.Success<typeof EnvironmentService.list>>
        >().pipe(
          Schedule.addDelay((result) =>
            Option.isNone(result) ? "60 seconds" : "10 seconds",
          ),
        ),
      ).pipe(
        Stream.filterMap((result) => result),
        // Schema-decoded values serialize with stable key order, so JSON text
        // is a sound structural equality for these small presence lists.
        Stream.changesWith(
          (previous, next) =>
            JSON.stringify(previous) === JSON.stringify(next),
        ),
      ),
    ),
  "Environment.suggestHosts": () =>
    EnvironmentService.suggestHosts().pipe(
      Effect.map((hosts) => hosts.map((host) => ({ ...host }))),
    ),
  "Environment.pairSsh": (input) => EnvironmentService.pairSsh(input),
  "Environment.rename": ({ deviceId, name }) =>
    EnvironmentService.rename(deviceId, name),
  "Environment.revoke": ({ deviceId }) => EnvironmentService.revoke(deviceId),
  "Config.get": configGet,
  "Setup.chooseReposDir": chooseReposDir,
  "Projects.list": ({ environmentId }) =>
    environmentId === undefined
      ? Effect.gen(function* () {
          const sessions = yield* SessionStore.list();
          const projects = yield* ProjectService.backfill(sessions);
          const byPath = new Map(
            projects.map((project) => [project.path, project.id]),
          );
          yield* Effect.forEach(
            sessions.filter(
              (session) =>
                session.environmentId === undefined &&
                session.projectId === undefined &&
                session.repoPath !== undefined,
            ),
            (session) => {
              const projectId = byPath.get(resolve(session.repoPath!));
              return projectId === undefined
                ? Effect.void
                : SessionStore.setProject(session.id, projectId).pipe(
                    Effect.asVoid,
                  );
            },
            { concurrency: 1, discard: true },
          );
          return projects;
        })
      : RemoteSessionService.requestOnEnvironment(
          environmentId,
          "Projects.list",
          {},
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(Schema.Array(ProjectSchema))),
          Effect.map((projects) =>
            projects.map((project) => ({ ...project, environmentId })),
          ),
          Effect.mapError(
            (cause) =>
              new GitError({
                message: "Could not list projects on the selected device",
                cause,
              }),
          ),
        ),
  "Projects.register": (input) =>
    input.environmentId === undefined
      ? ProjectService.register(input)
      : RemoteSessionService.requestOnEnvironment(
          input.environmentId,
          "Projects.register",
          {
            path: input.path,
            ...(input.name === undefined ? {} : { name: input.name }),
          },
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(ProjectSchema)),
          Effect.map((project) => ({
            ...project,
            environmentId: input.environmentId,
          })),
          Effect.mapError(
            (cause) =>
              new GitError({
                message: "Could not register the remote project",
                cause,
              }),
          ),
        ),
  "Projects.browse": () =>
    Effect.flatMap(DialogService, (dialog) =>
      dialog.chooseDirectory({
        title: "Add project",
        message: "Choose an existing Git repository.",
        allowCreate: false,
      }),
    ),
  "Projects.browseCloneDestination": ({ repositoryName }) =>
    Effect.gen(function* () {
      const dialog = yield* DialogService;
      const path = yield* Path.Path;
      const parent = yield* dialog.chooseDirectory({
        title: `Clone ${repositoryName}`,
        message: "Choose the folder where this repository should be cloned.",
        allowCreate: true,
      });
      if (parent === null) return null;
      const directoryName = path.basename(
        repositoryName.trim().replace(/\.git$/i, ""),
      );
      if (directoryName.length === 0 || directoryName === ".") {
        return null;
      }
      return path.join(parent, directoryName);
    }),
  "Projects.listDirectories": ({ path }) => listProjectDirectories(path),
  "Projects.createDirectory": (input) =>
    input.environmentId === undefined
      ? ProjectService.createDirectory(input)
      : RemoteSessionService.requestOnEnvironment(
          input.environmentId,
          "Projects.createDirectory",
          {
            path: input.path,
            ...(input.name === undefined ? {} : { name: input.name }),
          },
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(ProjectSchema)),
          Effect.map((project) => ({
            ...project,
            environmentId: input.environmentId,
          })),
          Effect.mapError(
            (cause) =>
              new GitError({
                message: "Could not create the remote project",
                cause,
              }),
          ),
        ),
  "Projects.clone": (input) =>
    input.environmentId === undefined
      ? ProjectService.clone(input)
      : RemoteSessionService.requestOnEnvironment(
          input.environmentId,
          "Projects.clone",
          {
            url: input.url,
            destination: input.destination,
            ...(input.name === undefined ? {} : { name: input.name }),
          },
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(ProjectSchema)),
          Effect.map((project) => ({
            ...project,
            environmentId: input.environmentId,
          })),
          Effect.mapError(
            (cause) =>
              new GitError({
                message: "Could not clone the remote project",
                cause,
              }),
          ),
        ),
  "Projects.cloneFromGitHub": (input) =>
    Effect.gen(function* () {
      const clone = input.installationId === undefined
        ? GitHubApi.cloneRepository(input.repository, input.destination)
        : GitHubAuth.credentialsForInstallation(
            input.installationId,
            input.repository,
            ["contents:read"],
          ).pipe(
            Effect.flatMap((credential) =>
              GitService.cloneWithInstallationToken(
                input.destination,
                input.repository,
                credential.token,
              ),
            ),
          );
      yield* clone;
      return yield* ProjectService.register({
        path: input.destination,
        ...(input.name === undefined ? {} : { name: input.name }),
      });
    }),
  "Projects.ensureOnEnvironment": ({ projectId, environmentId }) =>
    Effect.gen(function* () {
      const project = yield* ProjectService.get(projectId);
      return yield* ensureProjectOnOwnedEnvironment(project, environmentId);
    }),
  "Projects.setWorkflow": ({ projectId, setup, cleanup, runs, copyFiles, ports, approve }) =>
    ProjectService.setWorkflow(
      projectId,
      {
        ...(setup === undefined ? {} : { setup }),
        ...(cleanup === undefined ? {} : { cleanup }),
        runs,
        copyFiles,
        ...(ports ? { ports } : {}),
      },
      approve,
    ),
  "WorkspacePorts.check": ({ sessionId }) => Effect.gen(function* () {
    const session = yield* resolveSession(sessionId);
    const ports = session?.workspacePorts;
    if (!ports) return [];
    const sessions = yield* SessionStore.list();
    const reserved = new Set(sessions.filter((item) => item.id !== sessionId).flatMap((item) => item.workspacePorts ? [item.workspacePorts.primary, ...Object.values(item.workspacePorts.extras)] : []));
    return yield* Effect.tryPromise({ try: async () => {
      const assigned = [ports.primary, ...Object.values(ports.extras)];
      const availability = await Promise.all(assigned.map(workspacePortAvailable));
      return assigned.filter((port, index) => reserved.has(port) || !availability[index]);
    }, catch: (cause) => new GitError({ message: "Could not check workspace ports", cause }) });
  }),
  "WorkspacePorts.reassign": ({ sessionId }) => SessionStore.reassignWorkspacePorts(sessionId),
  "WorkspacePorts.preview": ({ sessionId }) => Effect.gen(function* () {
    const session = yield* resolveSession(sessionId);
    if (!session?.workspacePorts || !session.projectId || session.environmentId || session.workspaceMode === "direct") return yield* Effect.fail(new GitError({ message: "Preview requires an isolated local workspace with assigned ports." }));
    const project = yield* ProjectService.get(session.projectId);
    return yield* Effect.tryPromise({
      try: async () => {
        return await readyWorkspacePreview(project.workflow, session.workspacePorts!);
      }, catch: (cause) => new GitError({ message: cause instanceof Error ? cause.message : "Preview unavailable", cause })
    });
  }),
  "WorkspaceCheckpoints.setMode": ({ sessionId, enabled }) => WorkspaceCheckpointService.setMode(sessionId, enabled),
  "WorkspaceCheckpoints.list": ({ sessionId }) => WorkspaceCheckpointService.list(sessionId),
  "WorkspaceCheckpoints.capture": ({ sessionId }) => WorkspaceCheckpointService.capture(sessionId),
  "WorkspaceCheckpoints.preview": ({ sessionId, checkpointId }) => WorkspaceCheckpointService.preview(sessionId, checkpointId),
  "WorkspaceCheckpoints.restore": ({ sessionId, checkpointId, token }) => WorkspaceCheckpointService.restore(sessionId, checkpointId, token),
  "WorkspaceWorkflow.retrySetup": ({ sessionId }) => WorkspaceWorkflowService.setup(sessionId),
  "WorkspaceWorkflow.skipSetup": ({ sessionId }) => WorkspaceWorkflowService.skipSetup(sessionId),
  "WorkspaceWorkflow.startRun": ({ sessionId, runId }) => WorkspaceWorkflowService.startRun(sessionId, runId),
  "WorkspaceWorkflow.stopRun": ({ sessionId, runId }) => WorkspaceWorkflowService.stopRun(sessionId, runId),
  "WorkspaceWorkflow.listRuns": ({ sessionId }) => WorkspaceWorkflowService.listRuns(sessionId),
  "Projects.remove": ({ id, environmentId }) =>
    environmentId === undefined
      ? ProjectService.remove(id)
      : RemoteSessionService.requestOnEnvironment(
          environmentId,
          "Projects.remove",
          { id },
        ).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new GitError({
                message: "Could not remove the remote project registration",
                cause,
              }),
          ),
        ),
  "Workspace.repos": () => WorkspaceService.listRepos(),
  "Workspace.branches": ({ repoPath, environmentId }) =>
    environmentId
      ? RemoteSessionService.requestOnEnvironment(
          environmentId,
          "Workspace.branches",
          { repoPath },
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(Schema.Array(Schema.String))),
          Effect.mapError(
            (cause) =>
              new GitError({
                message: "Could not list remote branches",
                cause,
              }),
          ),
        )
      : WorkspaceService.branches(repoPath),
  "Workspace.files": ({ repoPath, environmentId, sessionId }) =>
    environmentId
      ? (sessionId
          ? RemoteSessionService.request(
              { id: sessionId, environmentId },
              "Workspace.files",
              { repoPath },
            )
          : RemoteSessionService.requestOnEnvironment(
              environmentId,
              "Workspace.files",
              { repoPath },
            )
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(Schema.Array(Schema.String))),
          Effect.mapError(
            (cause) =>
              new GitError({ message: "Could not list remote files", cause }),
          ),
        )
      : WorkspaceService.files(repoPath),
  "Workspace.revertFile": (input) => workspaceRevertFile(input),
  "Workspace.revertLines": (input) => workspaceRevertLines(input),
  // Migrated sessions whose runtime identity could not be resolved at
  // migration time adopt one here, the moment an authenticated connection can
  // satisfy them — so a pre-PI conversation continues without the operator
  // re-choosing what they already had. No-op for healthy sessions.
  "Sessions.list": () => healMigratedRuntimeIdentities.pipe(
    Effect.andThen(SessionStore.reconcileInterruptedWorkspaceLifecycles().pipe(Effect.ignore)),
    Effect.andThen(SessionStore.list()),
  ),
  "Sessions.get": ({ id }) => SessionStore.get(id),
  "Sessions.create": ({ requestedSessionId: _internalSessionId, ...input }) =>
    createSessionRouted(input),
  "Sessions.createWithProgress": ({
    requestedSessionId: _internalSessionId,
    ...input
  }) =>
    sessionCreationStream((progress) => createSessionRouted(input, progress)),
  "Sessions.createFromPr": ({
    requestedSessionId: _internalSessionId,
    ...input
  }) => createSessionFromPrRouted(input),
  "Sessions.createFromPrWithProgress": ({
    requestedSessionId: _internalSessionId,
    ...input
  }) =>
    sessionCreationStream((progress) =>
      createSessionFromPrRouted(input, progress),
    ),
  "Sessions.createFromIssue": ({
    requestedSessionId: _internalSessionId,
    ...input
  }) => createSessionFromIssueRouted(input),
  "Sessions.createFromIssueWithProgress": ({
    requestedSessionId: _internalSessionId,
    ...input
  }) =>
    sessionCreationStream((progress) =>
      createSessionFromIssueRouted(input, progress),
    ),
  "Sessions.linkIssue": (input) => linkIssue(input),
  "Sessions.addIssues": (input) => addIssues(input),
  "Sessions.selectIssue": ({ sessionId, issue }) => selectIssue(sessionId, issue),
  "Sessions.removeIssue": ({ sessionId, issue }) => removeIssue(sessionId, issue),
  "Sessions.unlinkIssue": ({ sessionId }) => unlinkIssue(sessionId),
  "Sessions.clearInitialPrompt": ({ sessionId }) =>
    Effect.gen(function* () {
      yield* SessionStore.clearInitialPrompt(sessionId);
      return yield* SessionStore.get(sessionId);
    }),
  "Routines.list": () => RoutinesService.pipe(Effect.flatMap(service => service.list)),
  "Routines.save": ({ id, input }) => RoutinesService.pipe(Effect.flatMap(service => service.save(id, input))),
  "Routines.enable": ({ id, enabled }) => RoutinesService.pipe(Effect.flatMap(service => service.enable(id, enabled))),
  "Routines.delete": ({ id }) => RoutinesService.pipe(Effect.flatMap(service => service.delete(id))),
  "Routines.runNow": ({ id }) => RoutinesService.pipe(Effect.flatMap(service => service.runNow(id))),
  "Routines.cancel": ({ runId }) => RoutinesService.pipe(Effect.flatMap(service => service.cancel(runId))),
  "Sessions.archive": ({ sessionId, reason, skipCleanup, metadataOnlyAcknowledged }) =>
    archiveSessionRouted(sessionId, reason, skipCleanup, metadataOnlyAcknowledged),
  "Sessions.restore": ({ sessionId }) => restoreSession(sessionId),
  "Sessions.resolveRuntimeRecovery": ({ sessionId, runId, callId }) =>
    RuntimeRecoveryService.resolve(sessionId, runId, callId),
  "Sessions.retitle": ({ sessionId }) =>
    Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      return yield* retitleSession(
        sessionId,
        makeAgentRuntimeTitleGenerator(runtime),
      );
    }),
  "Sessions.rename": ({ sessionId, title }) => renameSession(sessionId, title),
  "Sessions.setStatus": ({ sessionId, status }) =>
    setSessionStatus(sessionId, status),
  "Sessions.setPersistent": ({ sessionId, persistent }) =>
    setSessionPersistent(sessionId, persistent),
  "Sessions.setEnvironment": ({ sessionId, environmentId }) =>
    setEnvironment(sessionId, environmentId),
  "Sessions.continueOnEnvironment": ({ sessionId, environmentId }) =>
    continueOnEnvironment(sessionId, environmentId),
  "Sessions.adoptBranch": ({ sessionId }) => adoptBranch(sessionId),
  "Sessions.forkOntoBranch": ({ sessionId }) => forkOntoBranch(sessionId),
  "Sessions.delete": ({ sessionId, skipCleanup }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (session?.environmentId) {
        const remote = yield* RemoteSessionService;
        yield* removeRemoteSessionMirror(
          remote.request(session, "Sessions.delete", { skipCleanup }),
          remote
            .forget(sessionId)
            .pipe(
              Effect.ignore,
              Effect.zipRight(SessionStore.forgetRemote(sessionId)),
            ),
        );
        return;
      }
      const relayRoute = yield* GitHubAuth.sessionRoutes().pipe(
        Effect.map(
          (routes) =>
            routes.find((candidate) => candidate.sessionId === sessionId) ??
            null,
        ),
        Effect.orElseSucceed(() => null),
      );
      const workflow = yield* WorkspaceWorkflowService;
      yield* workflow.prepareLifecycle(sessionId);
      const closure = yield* beginWorkspaceLifecycle(sessionId, "workspace deletion is in progress");
      const runner = yield* AgentRunner;
      const terminals = yield* TerminalService;
      const browserControl = yield* BrowserControlMcpService;
      const preview = yield* PreviewViewService;
      const chats = allSessionChats(session);
      for (const chat of chats) {
        // Deletion is stronger than an ordinary Stop click: do not remove the
        // transcript/state until the harness finalizers have actually finished.
        yield* runner.stop(sessionId, chat.id, true);
      }
      yield* terminals.killSession(sessionId).pipe(
        Effect.mapError((cause) => new GitError({ message: cause.message, cause })),
      );
      yield* workflow.stopAll(sessionId);
      yield* Effect.tryPromise({
        try: () => waitForWorkspaceIdle(sessionId),
        catch: (cause) => new GitError({ message: "Workspace activity did not stop before deletion", cause }),
      });
      if (!skipCleanup) yield* workflow.cleanup(sessionId, closure);
      yield* browserControl.revoke(sessionId);
      yield* preview.deleteSession(sessionId, chats.map((chat) => chat.id));
      yield* BackgroundTaskStore.clear(sessionId);
      const offload = yield* makeOffloadCommandRouter
      yield* offload.destroySession(sessionId).pipe(Effect.ignore)
      if (session?.worktreePath) {
        yield* Effect.tryPromise(() => disposeLanguageIntelligence(session.worktreePath!)).pipe(Effect.ignore);
      }
      yield* SessionStore.remove(sessionId);
      if (relayRoute) {
        yield* GitHubAuth.unlinkSessionRoute(relayRoute.relaySessionId).pipe(
          Effect.ignore,
        );
      }
      for (const chat of chats) {
        yield* TranscriptStore.remove(chat.id);
        yield* ContextManager.forget(chat.id);
        // Same per-chat reclaim `Chats.delete` does — without it, a session
        // deleted whole left every chat's mode/approval entries in the
        // runner's maps for the app's lifetime.
        yield* runner.forgetChat(chat.id);
      }
      if (session?.worktreePath) {
        yield* ExplanationStore.removeAll(session.worktreePath, session.id);
      }
      yield* ReviewStore.clear(sessionId);
      lifecycleClosures.delete(sessionId);
    }).pipe(Effect.scoped),
  "Sessions.createChat": ({ sessionId }) =>
    SessionStore.createChat(sessionId).pipe(
      Effect.catchTag("SessionNotFoundError", (cause) =>
        Effect.fail(new GitError({ message: "Session not found", cause })),
      ),
    ),
  "Sessions.selectChat": ({ sessionId, chatId }) =>
    SessionStore.selectChat(sessionId, chatId).pipe(
      Effect.catchTag("SessionNotFoundError", (cause) =>
        Effect.fail(new GitError({ message: "Session not found", cause })),
      ),
    ),
  "Sessions.renameChat": ({ sessionId, chatId, title }) =>
    SessionStore.renameChat(sessionId, chatId, title).pipe(
      Effect.catchTag("SessionNotFoundError", (cause) =>
        Effect.fail(new GitError({ message: "Session not found", cause })),
      ),
    ),
  "Sessions.closeChat": ({ sessionId, chatId, discard }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId);
      if (!session.chats.some((chat) => chat.id === chatId)) return session;
      const runner = yield* AgentRunner;
      // Remove the chat from the active session first so a racing prompt cannot
      // start after stop. Then wait for the existing writer to finish before
      // deciding whether the transcript is still empty.
      let updated = yield* SessionStore.closeChat(sessionId, chatId);
      yield* runner.stop(sessionId, chatId, true);
      const discardEmpty = discard
        ? (yield* TranscriptStore.listPage(chatId, { limit: 1 })).messages.length === 0
        : false;
      if (discardEmpty) {
        yield* TranscriptStore.remove(chatId);
        updated = yield* SessionStore.discardClosedChat(sessionId, chatId);
      }
      // Drop the closed chat's per-chat state so it can't leak or strand rows:
      // its background-task rows + stop handle (nothing else sweeps a chat that
      // never runs again), and the runner's per-chat maps (the lock in particular
      // grows one-per-chat for the life of the process).
      yield* BackgroundTaskStore.clearChat(sessionId, chatId);
      yield* runner.forgetChat(chatId);
      yield* Effect.flatMap(PreviewViewService, (preview) =>
        preview.closeBrowser(sessionId, chatId),
      );
      yield* ContextManager.forget(chatId);
      if (session.worktreePath) {
        yield* ExplanationStore.rehome(
          session.worktreePath,
          sessionId,
          updated.activeChatId,
        ).pipe(Effect.ignore);
      }
      return updated;
    }).pipe(
      Effect.catchTag("SessionNotFoundError", (cause) =>
        Effect.fail(new GitError({ message: "Session not found", cause })),
      ),
    ),
  "Sessions.reopenChat": ({ sessionId, chatId }) =>
    SessionStore.reopenChat(sessionId, chatId).pipe(
      Effect.catchTag("SessionNotFoundError", (cause) =>
        Effect.fail(new GitError({ message: "Session not found", cause })),
      ),
    ),
  // The windowed read the renderer opens sessions with — only the tail loads,
  // older turns page in on demand. Same attachment-stripping as the whole read.
  "Sessions.transcriptPage": ({ sessionId, chatId, before, limit }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId);
      const remote = yield* RemoteSessionService;
      return yield* routeSessionOperation(
        session,
        "Sessions.transcriptPage",
        { chatId, before, limit },
        {
          execute: () =>
            Effect.gen(function* () {
              if (!session.chats.some((chat) => chat.id === chatId)) {
                return { messages: [], hasMore: false };
              }
              if (chatId === `c_${session.id}_1`) {
                yield* TranscriptStore.adoptLegacy(sessionId, chatId);
              }
              const page = yield* TranscriptStore.listPage(chatId, {
                before,
                limit,
              });
              return {
                messages: withoutAttachmentData(page.messages),
                hasMore: page.hasMore,
                ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
              };
            }),
        },
        {
          execute: () =>
            remote
              .request(session, "Sessions.transcriptPage", {
                chatId,
                before,
                limit,
              })
              .pipe(
                Effect.flatMap(
                  Schema.decodeUnknown(
                    Schema.Struct({
                      messages: Schema.Array(MessageSchema),
                      hasMore: Schema.Boolean,
                      cursor: Schema.optional(Schema.String),
                    }),
                  ),
                ),
              ),
        },
      );
    }).pipe(
      Effect.orElseSucceed(() => ({
        messages: [],
        hasMore: false,
      })),
    ),
  /**
   * The bytes `Sessions.transcriptPage` left out, one attachment at a time.
   *
   * Reads the whole transcript to find one image, which sounds wasteful and is
   * the right trade: the read happens in MAIN, where a 46MB parse is a
   * measurable but survivable cost that is immediately collected, and it saves
   * the renderer — where the same bytes are retained for the life of the actor
   * and where neither V8 nor PartitionAlloc give a spike's pages back.
   */
  "Sessions.attachment": ({ chatId, attachmentId }) =>
    Effect.gen(function* () {
      const messages = yield* TranscriptStore.list(chatId);
      for (const message of messages) {
        for (const part of message.parts) {
          if (part._tag !== "Image") continue;
          if (part.attachment.id !== attachmentId) continue;
          return part.attachment.data;
        }
      }
      return null;
    }).pipe(Effect.orElseSucceed(() => null)),
  "Sessions.diff": ({ id }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(id);
      const remote = yield* RemoteSessionService;
      return yield* routeSessionOperation(
        session,
        "Sessions.diff",
        {},
        { execute: () => sessionDiff(id) },
        {
          execute: () =>
            remote
              .request(session, "Sessions.diff", {})
              .pipe(Effect.flatMap(Schema.decodeUnknown(SessionReviewDiff))),
        },
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof GitError
          ? cause
          : new GitError({ message: "Could not load the session diff", cause }),
      ),
    ),
  "Sessions.diffStat": ({ id }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(id);
      const remote = yield* RemoteSessionService;
      return yield* routeSessionOperation(
        session,
        "Sessions.diffStat",
        {},
        { execute: () => sessionDiffStat(id) },
        {
          execute: () =>
            remote.request(session, "Sessions.diffStat", {}).pipe(
              Effect.flatMap(Schema.decodeUnknown(SessionDiffStat)),
            ),
        },
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof GitError
          ? cause
          : new GitError({ message: "Could not count the session diff", cause }),
      ),
    ),
  "Sessions.fileDiff": ({ id, path }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(id);
      const remote = yield* RemoteSessionService;
      return yield* routeSessionOperation(
        session,
        "Sessions.fileDiff",
        { path },
        { execute: () => sessionFileDiff(id, path) },
        {
          execute: () =>
            remote.request(session, "Sessions.fileDiff", { path }).pipe(
              Effect.flatMap(Schema.decodeUnknown(SessionFileDiff)),
            ),
        },
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof GitError
          ? cause
          : new GitError({ message: "Could not load the file diff", cause }),
      ),
    ),
  // The streaming agent seam: unwrap the runner's `Stream<StreamEvent>` so the
  // renderer subscribes to normalized events, harness-agnostic.
  "Agent.run": ({
    sessionId,
    chatId,
    text,
    displayText,
    images,
    reasoning,
    externalInstruction,
  }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const session = yield* SessionStore.get(sessionId);
        const runner = yield* AgentRunner;
        const remote = yield* RemoteSessionService;
        return yield* routeSessionOperation(
          session,
          "Agent.run",
          { chatId, text, displayText, images, reasoning, externalInstruction },
          {
            execute: () =>
              Effect.succeed(
                runner.prompt(
                  sessionId,
                  chatId,
                  text,
                  images ?? [],
                  reasoning,
                  undefined,
                  externalInstruction,
                  displayText,
                ),
              ),
          },
          {
            execute: () =>
              Effect.succeed(
                remote
                  .execute(session, "Agent.run", {
                    chatId,
                    text,
                    displayText,
                    images,
                    reasoning,
                    externalInstruction,
                  })
                  .pipe(
                    Stream.tap((event) =>
                      event.kind !== "complete"
                        ? Effect.void
                        : Schema.decodeUnknown(
                            Schema.Struct({ session: SessionSchema }),
                          )(event.payload).pipe(
                            Effect.flatMap(({ session: remoteSession }) =>
                              SessionStore.upsertRemote(remoteSession),
                            ),
                            Effect.ignore,
                          ),
                    ),
                    Stream.filter((event) => event.kind !== "complete"),
                    Stream.mapEffect((event) =>
                      event.kind === "failed"
                        ? Effect.succeed<StreamEvent>({
                            _tag: "Failed",
                            message:
                              event.payload &&
                              typeof event.payload === "object" &&
                              "message" in event.payload &&
                              typeof event.payload.message === "string"
                                ? event.payload.message
                                : "The remote operation failed.",
                          })
                        : Schema.decodeUnknown(StreamEventSchema)(
                            event.payload,
                          ).pipe(
                            Effect.orElseSucceed((): StreamEvent => ({
                              _tag: "Failed",
                              message:
                                "The remote device returned an invalid agent event.",
                            })),
                          ),
                    ),
                    Stream.catchAll((error) =>
                      Stream.make({
                        _tag: "Failed" as const,
                        message: error.message,
                      }),
                    ),
                  ),
              ),
          },
        );
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed(
            Stream.make({
              _tag: "Failed" as const,
              message:
                "message" in error && typeof error.message === "string"
                  ? error.message
                  : "The session could not be started.",
            }),
          ),
        ),
      ),
    ),
  "Agent.decideGate": ({ sessionId, chatId, gateId, decision }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId);
      const runner = yield* AgentRunner;
      const remote = yield* RemoteSessionService;
      return yield* routeSessionOperation(
        session,
        "Agent.decideGate",
        { chatId, gateId, decision },
        {
          execute: () => runner.decideGate(sessionId, chatId, gateId, decision),
        },
        {
          execute: () =>
            remote
              .request(session, "Agent.decideGate", {
                chatId,
                gateId,
                decision,
              })
              .pipe(Effect.asVoid),
        },
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new GitError({
            message: "Could not submit the approval decision",
            cause,
          }),
      ),
    ),
  "Agent.answerQuestion": ({ sessionId, chatId, requestId, answers }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId);
      const runner = yield* AgentRunner;
      const remote = yield* RemoteSessionService;
      return yield* routeSessionOperation(
        session,
        "Agent.answerQuestion",
        { chatId, requestId, answers },
        {
          execute: () =>
            runner.answerQuestion(sessionId, chatId, requestId, answers),
        },
        {
          execute: () =>
            remote
              .request(session, "Agent.answerQuestion", {
                chatId,
                requestId,
                answers,
              })
              .pipe(Effect.asVoid),
        },
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new GitError({ message: "Could not submit the answer", cause }),
      ),
    ),
  "Agent.setMode": ({ sessionId, chatId, mode }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.setMode(sessionId, chatId, mode),
    ),
  "Agent.setReasoning": ({ sessionId, chatId, reasoning }) =>
    setReasoning(sessionId, chatId, reasoning),
  "Agent.setModel": ({
    sessionId,
    chatId,
    connectionId,
    providerId,
    modelId,
  }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.setModel(sessionId, chatId, connectionId, providerId, modelId),
    ),
  "Agent.stop": ({ sessionId, chatId }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId);
      const runner = yield* AgentRunner;
      const remote = yield* RemoteSessionService;
      return yield* routeSessionOperation(
        session,
        "Agent.stop",
        { chatId },
        { execute: () => runner.stop(sessionId, chatId) },
        {
          execute: () =>
            remote
              .request(session, "Agent.stop", { chatId })
              .pipe(Effect.asVoid),
        },
      );
    }).pipe(
      Effect.mapError(
        (cause) => new GitError({ message: "Could not stop the agent", cause }),
      ),
    ),
  // Local-only by design: a remote session's turns never contend with the
  // local single-flight slot, and its liveness surfaces through session
  // envelopes — reporting "not busy" is the correct answer for it here.
  "Agent.chatBusy": ({ chatId }) =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner;
      return yield* runner.chatBusy(chatId);
    }),
  "Agent.plannotatorRecoveryNeeded": ({ sessionId, chatId }) =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner;
      return yield* runner.plannotatorRecoveryNeeded(sessionId, chatId);
    }),
  // Not `AgentRunner.stop` scoped smaller: that halts the whole turn. A
  // sub-agent is killed through the run's own per-task handle, which is what
  // `BackgroundTaskStore` holds.
  "Agent.stopSubagent": ({ sessionId, chatId, agentId }) =>
    BackgroundTaskStore.stopHandled(sessionId, chatId, agentId),
  "Agent.subagentFleetSnapshot": ({
    sessionId,
    chatId,
    parentRuntimeSessionId
  }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId)
      const runtime = yield* AgentRuntime
      const owner = runtimeOwnerForSession(session, chatId)
      if (owner === null) return yield* Effect.fail(new Error("Session runtime endpoint is unavailable"))
      const remote = yield* RemoteSessionService
      return yield* routeSessionOperation(
        session,
        "Agent.subagentFleetSnapshot",
        { chatId, parentRuntimeSessionId },
        {
          execute: () => runtime.subagentFleetSnapshot(
            owner,
            sessionId,
            chatId,
            parentRuntimeSessionId
          )
        },
        {
          execute: () => remote.request(
            session,
            "Agent.subagentFleetSnapshot",
            { chatId, parentRuntimeSessionId }
          ).pipe(Effect.flatMap(Schema.decodeUnknown(SubagentFleetSnapshot)))
        }
      )
    }).pipe(
      Effect.mapError((cause) => new GitError({
        message:
          typeof cause === "object" &&
          cause !== null &&
          "message" in cause &&
          String(cause.message).toLowerCase().includes("pi session is not active")
            ? "Pi session is not active"
            : "Could not reconcile the subagent Fleet"
      }))
    ),
  "Agent.subagentTranscript": ({
    sessionId,
    chatId,
    parentRuntimeSessionId,
    runId
  }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId)
      const runtime = yield* AgentRuntime
      const owner = runtimeOwnerForSession(session, chatId)
      if (owner === null) return yield* Effect.fail(new Error("Session runtime endpoint is unavailable"))
      const remote = yield* RemoteSessionService
      return yield* routeSessionOperation(
        session,
        "Agent.subagentTranscript",
        { chatId, parentRuntimeSessionId, runId },
        {
          execute: () => runtime.subagentTranscript(
            owner,
            sessionId,
            chatId,
            parentRuntimeSessionId,
            runId
          )
        },
        {
          execute: () => remote.request(
            session,
            "Agent.subagentTranscript",
            { chatId, parentRuntimeSessionId, runId }
          ).pipe(Effect.flatMap(Schema.decodeUnknown(Schema.Array(MessageSchema))))
        }
      )
    }).pipe(
      Effect.mapError(
        (cause) => new GitError({ message: "Could not read the subagent transcript", cause })
      )
    ),
  "Agent.controlSubagent": ({ sessionId, chatId, request }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId)
      const runtime = yield* AgentRuntime
      const owner = runtimeOwnerForSession(session, chatId)
      if (owner === null) return yield* Effect.fail(new Error("Session runtime endpoint is unavailable"))
      const remote = yield* RemoteSessionService
      return yield* routeSessionOperation(
        session,
        "Agent.controlSubagent",
        { chatId, request },
        {
          execute: () => runtime.controlSubagent(owner, sessionId, chatId, request)
        },
        {
          execute: () => remote.request(
            session,
            "Agent.controlSubagent",
            { chatId, request }
          ).pipe(
            Effect.flatMap(Schema.decodeUnknown(SubagentFleetControlOutcome))
          )
        }
      )
    }).pipe(
      Effect.mapError(
        (cause) => new GitError({ message: "Could not control the subagent", cause })
      )
    ),
  "Agent.messagePeer": ({ sessionId, fromChatId, toChatId, text }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId)
      const runner = yield* AgentRunner
      return yield* routePeerAgentMessage(
        session.chats,
        fromChatId,
        toChatId,
        text,
        (target, attributedText) =>
          runner.steer(sessionId, target, attributedText, []).pipe(
            Effect.map((result) => result.status === "accepted")
          )
      )
    }).pipe(
      Effect.mapError((cause) =>
        new GitError({ message: "Could not message the peer agent", cause })
      )
    ),
  "Agent.steer": ({ sessionId, chatId, text, images }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId);
      const runner = yield* AgentRunner;
      const remote = yield* RemoteSessionService;
      return yield* routeSessionOperation(
        session,
        "Agent.steer",
        { chatId, text, images },
        { execute: () => runner.steer(sessionId, chatId, text, images) },
        {
          execute: () =>
            remote
              .request(session, "Agent.steer", { chatId, text, images })
              .pipe(
                Effect.flatMap((value) =>
                  Schema.decodeUnknown(
                    Schema.Union(
                      Schema.Struct({
                        status: Schema.Literal("accepted"),
                        user: MessageSchema,
                        assistant: MessageSchema,
                      }),
                      Schema.Struct({
                        status: Schema.Literal("deferred", "unsupported"),
                      }),
                    ),
                  )(value),
                ),
              ),
        },
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new GitError({ message: "Could not steer the agent", cause }),
      ),
    ),
  "Skills.list": ({ sessionId }) => skillsList(sessionId),
  "Mcp.list": () => mcpList(),
  "Mcp.status": () => mcpStatus(),
  "Mcp.write": ({ name, entry }) =>
    McpConfigService.write(name, entry).pipe(
      Effect.mapError((cause) => mcpError(cause.message, cause)),
    ),
  "Mcp.remove": ({ name }) =>
    Effect.gen(function* () {
      yield* McpConfigService.remove(name).pipe(
        Effect.mapError((cause) => mcpError(cause.message, cause)),
      );
      const secretStore = yield* SecretStore;
      yield* new McpAuthStore(secretStore).delete(name);
    }),
  "Mcp.setEnabled": ({ name, enabled }) =>
    McpConfigService.setEnabled(name, enabled).pipe(
      Effect.mapError((cause) => mcpError(cause.message, cause)),
    ),
  "Mcp.setAuth": ({ name, auth }) =>
    McpConfigService.setAuth(name, auth).pipe(
      Effect.mapError((cause) => mcpError(cause.message, cause)),
    ),
  "Mcp.setApiKey": ({ name, apiKey }) => mcpSetApiKey(name, apiKey),
  "Mcp.startAuthorization": ({ name }) => mcpStartAuthorization(name),
  "Mcp.importCandidates": ({ source }) =>
    mcpImportParse(source).pipe(
      Effect.map((candidates) =>
        candidates.map((candidate) => ({
          name: candidate.name,
          source: candidate.source,
          target: mcpCandidateTarget(candidate),
          problem: candidate.problem,
        })),
      ),
    ),
  "Mcp.applyImport": ({ source, names }) => mcpApplyImport(source, names),
  "Mcp.reveal": () => mcpReveal(),
  // Discovery supplies the CLI's resolved binary path — a GUI-launched Electron
  // app has a threadbare PATH, so Codex's own model list is only reachable via
  // the absolute path discovery found.
  "Usage.get": () =>
    ProviderConnections.pipe(
      Effect.flatMap((service) =>
        service.list.pipe(
          Effect.flatMap((catalog) =>
            UsageService.liveFromProviderCatalog(catalog, (entry) =>
              entry.connection.status !== "authenticated"
                ? Effect.succeed(null)
                : service.resolveCredential(entry.connection.id).pipe(
                    Effect.flatMap((credential) =>
                      Effect.tryPromise((signal) =>
                        fetchPiProviderUsage({
                          authKind: entry.connection.authKind,
                          access: credential.access,
                          accountId: credential.accountId,
                          fallbackAccess: null,
                          signal,
                        }),
                      ),
                    ),
                    Effect.timeout("8 seconds"),
                    Effect.catchAll(() => Effect.succeed(null)),
                  ),
            ),
          ),
        ),
      ),
      Effect.catchAll(() => Effect.succeed({ providers: [], fetchedAt: null })),
    ),
  "Usage.report": () =>
    AppPaths.pipe(
      Effect.flatMap((paths) => Effect.tryPromise({
        try: () => new UsageFactStore(join(paths.runJournalsDir, "usage-facts.json")).report(),
        catch: (cause) => new Error("Could not read the execution usage report", { cause })
      })),
      Effect.orDie
    ),
  "Context.state": ({ sessionId, chatId }) =>
    ContextManager.bindContext(chatId, sessionId).pipe(
      Effect.zipRight(ContextManager.snapshot(chatId)),
    ),
  // Fire-and-forget by design: the digest builds on a background fiber and lands
  // on the next turn, so the button returns instantly rather than parking the UI
  // on a summary the user is not waiting for.
  "Context.compactNow": ({ sessionId, chatId }) =>
    ContextManager.bindContext(chatId, sessionId).pipe(
      Effect.zipRight(ContextManager.compactNow(chatId)),
    ),
  "Config.setContext": (context) => ConfigService.setContext(context),
  "Config.setOffloadCompute": (offloadCompute) =>
    Effect.gen(function* () {
      const updated = yield* ConfigService.setOffloadCompute(offloadCompute)
      if (!offloadCompute.enabled) return updated
      const router = yield* makeOffloadCommandRouter
      const sessions = yield* SessionStore.list()
      yield* Effect.forkDaemon(
        primeOffloadSessions(sessions, (cwd, sessionId) =>
          router.primeSession(cwd, sessionId)
        )
      )
      return updated
    }),
  // Returns the updated session so the renderer can patch its cache without a
  // refetch, matching every other session mutation.
  "Sessions.setAutoCompact": ({ id, autoCompact }) =>
    SessionStore.setAutoCompact(id, autoCompact).pipe(
      Effect.zipRight(SessionStore.get(id)),
      Effect.catchTag("SessionNotFoundError", (cause) =>
        Effect.fail(new GitError({ message: "Session not found", cause })),
      ),
    ),
  "GitHub.status": () => githubConnectionStatus(),
  "GitHub.repositories": () => githubRepositories(),
  "GitHub.install": () => githubConnectionInstall(),
  "GitHub.refresh": () => githubConnectionRefresh(),
  "GitHub.disconnect": () => githubConnectionDisconnect(),
  "Config.setGithub": (github) => ConfigService.setGithub(github),
  "Config.setGit": (git) => ConfigService.setGit(git),
  "Config.setNotifications": (notifications) =>
    ConfigService.setNotifications(notifications),
  "Config.setDefaultMode": ({ defaultMode }) =>
    ConfigService.setDefaultMode(defaultMode),
  "Config.setSubagentDelegationEnabled": ({ enabled }) =>
    ConfigService.setSubagentDelegationEnabled(enabled),
  "Config.setSubagentModel": ({ providerId, agent, modelId }) =>
    ConfigService.setSubagentModel(providerId, agent, modelId),
  "Config.setPlanAutoRun": ({ planAutoRun }) =>
    ConfigService.setPlanAutoRun(planAutoRun),
  "Config.setAdhdMode": ({ adhdMode }) => ConfigService.setAdhdMode(adhdMode),
  "Config.setFontScale": ({ fontScale }) =>
    ConfigService.setFontScale(fontScale),
  "Config.setDefaultProviderModel": ({ connectionId, providerId, modelId }) =>
    ConfigService.setDefaultProviderModel(connectionId, providerId, modelId),
  "Config.completeProviderSetup": () => ConfigService.completeProviderSetup(),
  "Config.setWebSearch": (webSearch) => ConfigService.setWebSearch(webSearch),
  "WebSearch.get": () => webSearchSettingsStatus,
  "WebSearch.setCredential": (input) =>
    updateWebSearchAtomically(
      { setup: "configured", provider: input.provider },
      WebSearchCredentialService.set(input),
    ).pipe(Effect.zipRight(webSearchSettingsStatus)),
  "WebSearch.clearCredential": ({ provider }) =>
    updateWebSearchAtomically(
      { setup: "pending", provider: null },
      WebSearchCredentialService.clear(provider),
    ).pipe(Effect.zipRight(webSearchSettingsStatus)),
  "WebSearch.skip": () =>
    ConfigService.setWebSearch({ setup: "skipped", provider: null }).pipe(
      Effect.mapError(() => new WebSearchError({
        reason: "unavailable",
        message: "Could not skip WebSearch setup",
        retryable: true,
      })),
      Effect.zipRight(webSearchSettingsStatus),
    ),
  /**
   * Deliver an OS notification. Main decides whether to actually show it: it
   * owns the window's focus state, which the renderer cannot observe reliably,
   * and the stored prefs. A config read that fails must not swallow the alert,
   * so it falls back to `undefined` — which `shouldNotify` reads as "defaults".
   */
  "Notify.show": ({ sessionId, kind, title, body, isActiveSession }) =>
    ConfigService.get().pipe(
      Effect.catchAll(() => Effect.succeed(null)),
      Effect.map((config) => config?.notifications),
      Effect.flatMap((prefs) =>
        Effect.sync(() => {
          const win = BrowserWindow.getAllWindows()[0] ?? null;
          if (
            !shouldNotify({
              kind,
              windowFocused: win?.isFocused() ?? false,
              isActiveSession,
              config: prefs,
            })
          ) {
            return;
          }
          showNotification({ sessionId, kind, title, body }, prefs);
        }),
      ),
    ),
  "Config.setStarredRepos": ({ paths }) => ConfigService.setStarredRepos(paths),
  "Config.setCollapsedRepos": ({ paths }) =>
    ConfigService.setCollapsedRepos(paths),
  "Config.setLastRepoPath": ({ path }) => ConfigService.setLastRepoPath(path),
  "Config.setPlanTemplate": ({ template }) =>
    ConfigService.setPlanTemplate(template),
  "Github.events": () => interruptOnPageGone(githubEvents()),
  "Github.claimFeedback": (input) => {
    if (input.operation === "claim") {
      return SessionStore.claimGitHubFeedback(input.sessionId, input);
    }
    if (failGitHubFeedbackMarkOnce) {
      failGitHubFeedbackMarkOnce = false;
      return Effect.fail(
        new GitError({
          message: "E2E forced crash boundary before feedback outbox mark",
        }),
      );
    }
    return SessionStore.markGitHubFeedbackDispatched(
      input.sessionId,
      input.deliveryId,
      input.semanticKey,
    ).pipe(
      Effect.map((marked) =>
        marked ? ("dispatched" as const) : ("rejected" as const),
      ),
    );
  },
  "Github.ackEvent": ({ clientId, cursor, outcome }) =>
    githubAckEvent(clientId, cursor, outcome),
});

const ReviewHandlersLayer = JinglerReviewRpcs.toLayer({
  "Github.inbox": () => githubPrInbox(),
  "Github.prBySlug": ({ repository, number }) => githubPrBySlug(repository, number),
  "Github.pr": ({ sessionId }) => githubPr(sessionId),
  "Github.prState": ({ sessionId }) => githubPrState(sessionId),
  "Github.listPrs": ({ repoPath, githubSlug, mine, search }) =>
    githubSlug
      ? GitHubApi.listPrsBySlug(githubSlug, { mine, search })
      : GitHubApi.listPrs(repoPath, { mine, search }),
  "Github.listIssues": ({ repoPath, githubSlug, mine, search }) =>
    githubSlug
      ? GitHubApi.listIssuesBySlug(githubSlug, { mine, search })
      : GitHubApi.listIssues(repoPath, { mine, search }),
  "Github.closeIssue": ({ sessionId }) => githubCloseIssue(sessionId),
  "Github.issue": ({ sessionId }) => githubIssue(sessionId),
  "Github.files": ({ sessionId }) => githubFiles(sessionId),
  "Github.diff": ({ sessionId }) => githubDiff(sessionId),
  "Github.detectPr": ({ sessionId }) => githubDetectPr(sessionId),
  "Explanation.current": ({ sessionId }) =>
    SessionStore.get(sessionId).pipe(
      Effect.flatMap((session) =>
        session.worktreePath
          ? ExplanationStore.read(session.worktreePath, session.id)
          : Effect.succeed(null),
      ),
      Effect.orElseSucceed(() => null),
    ),
  "Explanation.watch": ({ sessionId }) =>
    interruptOnPageGone(explanationWatch(sessionId)),
  "Review.run": ({ sessionId, force }) => reviewRun(sessionId, force),
  // Unwrapped from the service like `Terminal.attach` — the reviewer outlives any
  // one watcher, so the stream attaches to it rather than starting it.
  "Review.watch": ({ sessionId, chatId }) =>
    interruptOnPageGone(
      Stream.unwrap(
        Effect.map(ReviewService, (r) => r.watch(sessionId, chatId)),
      ),
    ),
  "Review.get": ({ sessionId }) => reviewGet(sessionId),
  "Review.markRouted": ({ sessionId }) => reviewMarkRouted(sessionId),
  "Review.reconcile": ({ sessionId }) => reviewReconcile(sessionId),
  "Github.createPr": ({ sessionId }) => githubPublishRouted(sessionId),
  "Github.comment": (input) => githubComment(input),
  "Github.commentBySlug": (input) => githubCommentBySlug(input),
  "Github.closeBySlug": (input) => githubCloseBySlug(input),
  "Github.mergeBySlug": (input) => githubMergeBySlug(input),
  "Github.review": (input) => githubReview(input),
  "Github.submitReview": (input) => githubSubmitReview(input),
  "Github.resolveThread": (input) => githubResolveThread(input),
  "Github.replyToThread": (input) => githubReplyToThread(input),
  "Github.merge": (input) => githubMerge(input),
  "Github.markReady": (input) => githubMarkReady(input),
  "Github.updateBranch": (input) => githubUpdateBranch(input),

  // Terminal — PTY lifecycle is unary; the coalesced output path is a stream,
  // unwrapped from the service like `Agent.run`.
  "Terminal.create": (input) => createTerminal(input),
  "Terminal.attach": ({ terminalId }) =>
    interruptOnPageGone(
      Stream.unwrap(Effect.map(TerminalService, (t) => t.attach(terminalId))),
    ),
  "Terminal.write": ({ terminalId, data }) =>
    Effect.flatMap(TerminalService, (t) => t.write(terminalId, data)),
  "Terminal.resize": ({ terminalId, cols, rows }) =>
    Effect.flatMap(TerminalService, (t) => t.resize(terminalId, cols, rows)),
  "Terminal.kill": ({ terminalId }) =>
    Effect.flatMap(TerminalService, (t) => t.kill(terminalId)),
  "Terminal.list": ({ sessionId }) =>
    Effect.flatMap(TerminalService, (t) => t.list(sessionId)),

  // Background tasks — harness work that outlives the turn that started it.
  "BackgroundTasks.list": ({ sessionId }) =>
    BackgroundTaskStore.list(sessionId),
  "BackgroundTasks.stop": ({ sessionId, taskId }) =>
    BackgroundTaskStore.stop(sessionId, taskId),
  "BackgroundTasks.dismiss": ({ sessionId, taskId }) =>
    BackgroundTaskStore.dismiss(sessionId, taskId),
  "BackgroundTasks.output": ({ sessionId, taskId }) =>
    backgroundTaskOutput(sessionId, taskId),

  // Browser preview — a native WebContentsView over a localhost dev server,
  // driven from the renderer's preview pane (bounds streamed to stay aligned).
  "BrowserPreview.open": ({ sessionId, chatId, url, bounds }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.openBrowser(sessionId, chatId, url, bounds),
    ),
  "BrowserPreview.setBounds": ({ sessionId, chatId, bounds }) =>
    Effect.flatMap(PreviewViewService, (b) => b.setBounds(sessionId, chatId, bounds)),
  "BrowserPreview.navigate": ({ sessionId, chatId, url }) =>
    Effect.flatMap(PreviewViewService, (b) => b.navigate(sessionId, chatId, url)),
  "BrowserPreview.reload": ({ sessionId, chatId }) =>
    Effect.flatMap(PreviewViewService, (b) => b.reload(sessionId, chatId)),
  "BrowserPreview.setVisible": ({ sessionId, chatId, visible }) =>
    Effect.flatMap(PreviewViewService, (b) => b.setVisible(sessionId, chatId, visible)),
  "BrowserPreview.close": ({ sessionId, chatId }) =>
    Effect.flatMap(PreviewViewService, (b) => b.closeBrowser(sessionId, chatId)),
  // Native plan review: the renderer's PlanReview surface delivers the
  // operator's verdict straight onto the live session's event bus, where the
  // forked Plannotator extension resolves its awaited review by reviewId.
  "Plan.decide": ({ sessionId, chatId, reviewId, approved, feedback }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId)
      const owner = runtimeOwnerForSession(session, chatId)
      if (owner === null) return yield* Effect.fail(new Error("Session runtime endpoint is unavailable"))
      const runtime = yield* AgentRuntime
      yield* runtime.decidePlanReview(owner, sessionId, chatId, {
        reviewId,
        approved,
        ...(feedback === undefined ? {} : { feedback })
      })
    }).pipe(
      Effect.mapError(
        (cause) => new GitError({ message: "Could not deliver the plan review decision", cause })
      )
    ),
  // Browser control — the SAME native view, driven by an agent (via the
  // browser-control MCP) so it can QA a preview URL where the operator watches.
  // Each op reveals the dock inside PreviewViewService.
  "BrowserControl.navigate": ({ sessionId, chatId, url }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.controlNavigate(sessionId, chatId, url),
    ),
  "BrowserControl.screenshot": ({ sessionId, chatId }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlScreenshot(sessionId, chatId)),
  "BrowserControl.click": ({ sessionId, chatId, selector }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.controlClick(sessionId, chatId, selector),
    ),
  "BrowserControl.type": ({ sessionId, chatId, selector, text }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.controlType(sessionId, chatId, selector, text),
    ),
  "BrowserControl.readText": ({ sessionId, chatId }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlReadText(sessionId, chatId)),
  "BrowserControl.evaluate": ({ sessionId, chatId, expression }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.controlEvaluate(sessionId, chatId, expression),
    ),
  "BrowserControl.waitForSelector": ({ sessionId, chatId, selector, timeoutMs }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.controlWaitForSelector(sessionId, chatId, selector, timeoutMs),
    ),

  "Asset.hover": (input) => assetHover(input),
  "Asset.read": (input) => assetRead(input),
  "Asset.write": (input) => assetWrite(input),
  "Asset.reveal": (input) => assetReveal(input),
  "Asset.openPdf": (input) => assetOpenPdf(input),
  "Asset.setPdfBounds": ({ sessionId, bounds }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.setFileBounds(sessionId, bounds),
    ),
  "Asset.hidePdf": ({ sessionId }) =>
    Effect.flatMap(PreviewViewService, (b) => b.hideFile(sessionId)),

  // Auth — the sign-in wall. Delegates to AuthService, which bridges the OS
  // keychain (SecretStore) and the BetterAuth backend.
  "Auth.getSession": authenticatedSession,
  "Auth.startSignIn": ({ provider }) => AuthService.startSignIn(provider),
  "Auth.sendMagicLink": ({ email, name }) =>
    AuthService.sendMagicLink(email, name),
  "Auth.signOut": () => RoutinesService.pipe(Effect.flatMap(service => service.stop), Effect.catchAll(cause => Effect.logError(cause.message)), Effect.zipRight(AuthService.signOut())),

  // Themes — the picker, the editor, and live reload of `~/jingler/themes`.
  "Theme.list": () => ThemeService.list(),
  "Theme.get": ({ id }) => ThemeService.get(id),
  "Theme.save": ({ id, theme }) => ThemeService.save(id, theme),
  "Theme.delete": ({ id }) => ThemeService.remove(id),
  "Theme.duplicate": ({ id, name }) => ThemeService.duplicate(id, name),
  "Theme.import": ({ json, name }) => ThemeService.importJson(json, name),
  "Theme.setActive": ({ id }) => ConfigService.setActiveTheme(id),
  "Theme.setCustomizations": ({ colors }) =>
    ConfigService.setThemeCustomizations({ ...colors }),

  /**
   * `Stream.unwrap(Effect.map(…))`, NOT the `ThemeService.watch()` accessor.
   *
   * An `Effect` is itself a `Stream` of one element, so the accessor form —
   * `Effect<Stream<ThemeCatalog>>` — type-checks here and silently produces a
   * stream whose single element is the real stream. No error, no catalog, and
   * live reload just never fires. Same shape as `Review.watch` above, for the
   * same reason.
   */
  "Theme.watch": () =>
    interruptOnPageGone(
      Stream.unwrap(Effect.map(ThemeService, (t) => t.watch())),
    ),

  /**
   * Confined to `~/jingler/themes` on purpose.
   *
   * The renderer supplies the path, and the renderer renders untrusted content
   * (agent markdown, PR bodies). An unconstrained reveal would be a way to make
   * the app open an arbitrary filesystem location. Only an immediate child of
   * the themes directory is valid — the same confinement rule ThemeService
   * applies to reads, writes and deletes.
   */
  "Theme.reveal": ({ path }) =>
    Effect.flatMap(AppPaths, (paths) =>
      Effect.sync(() => {
        const themesDir = resolve(paths.themesDir);
        const file = resolve(path);
        if (dirname(file) === themesDir) shell.showItemInFolder(file);
      }),
    ),

  // ── Plugins ────────────────────────────────────────────────────────────────
  // Registry, settings and extension-host operations share this handler group;
  // `toLayer` keeps the RPC contract exhaustive at compile time.

  "Plugins.list": () => PluginRegistry.list(),

  // `Stream.unwrap(Effect.map(...))`, not the accessor — the accessor form
  // yields a stream OF a stream and the renderer receives nothing. Same shape
  // as `Theme.watch` above, and for the same reason.
  "Plugins.watch": () =>
    interruptOnPageGone(
      Stream.unwrap(
        Effect.map(PluginRegistry, (p) =>
          // Every emission means the directory changed, so the resolution cache
          // used by plugin resolution is stale by definition.
          p
            .watch()
            .pipe(Stream.tap(() => Effect.sync(invalidatePluginCatalog))),
        ),
      ),
    ),

  /**
   * Flip the switch, and STOP the plugin if it is being turned off.
   *
   * Writing `disabledPlugins` alone made "disabled" mean "contributes no UI and
   * accepts no new invokes". The renderer stops rendering its tabs, so it looks
   * off — while an already-activated host half keeps its subscriptions, its
   * timers and any in-flight work running until the app restarts.
   *
   * Disabling is almost always damage control: the plugin is doing something the
   * operator wants stopped, and it was the one thing the switch did not do.
   */
  "Plugins.setEnabled": ({ pluginId, enabled }) =>
    Effect.gen(function* () {
      yield* PluginRegistry.setEnabled(pluginId, enabled);
      if (!enabled) yield* deactivateQuietly(pluginId);
    }),

  /**
   * Uninstall, and drop the plugin's credentials with it.
   *
   * Leaving grants behind would mean reinstalling a plugin silently restores
   * access the operator revoked by deleting it — the strongest revocation
   * gesture there is, and the one they would most expect to stick.
   */
  "Plugins.uninstall": ({ pluginId }) => uninstallPlugin(pluginId),

  "Plugins.installFromFolder": ({ sourcePath }) =>
    PluginRegistry.installFromFolder(sourcePath),

  "Plugins.installFromPicker": () =>
    Effect.gen(function* () {
      const dialog = yield* DialogService;
      const chosen = yield* dialog.chooseDirectory({
        title: "Install a plugin",
        message:
          "Choose a plugin folder — the one containing jingler.plugin.json.",
        // No "New Folder": a folder made in the picker is empty, and an empty
        // folder fails the manifest check a moment later. Offering the button
        // only invites that.
        allowCreate: false,
      });
      // Cancelled. Not an error — see the contract for why this is a `null`
      // success rather than a `PluginError`.
      if (chosen === null) return null;
      return yield* PluginRegistry.installFromFolder(chosen);
    }),

  // Confinement is the service's job (`dirFor` fails for anything that resolves
  // outside `pluginsDir`), so this handler cannot be tricked into revealing an
  // arbitrary path by a renderer that sends a crafted id.
  "Plugins.reveal": ({ pluginId }) =>
    Effect.flatMap(PluginRegistry.dirFor(pluginId), (dir) =>
      Effect.sync(() => {
        shell.showItemInFolder(dir);
      }),
    ),

  "Plugins.storageGet": ({ pluginId, key }) => pluginStorageGet(pluginId, key),

  "Plugins.storageSet": ({ pluginId, key, value }) =>
    pluginStorageSet(pluginId, key, value),

  "Plugins.storageDelete": ({ pluginId, key }) =>
    pluginStorageDelete(pluginId, key),

  "Plugins.storageKeys": ({ pluginId }) => pluginStorageKeys(pluginId),

  "Plugins.settingsGet": ({ pluginId }) => pluginSettingsGet(pluginId),

  "Plugins.settingSet": ({ pluginId, settingId, value }) =>
    pluginSettingSet(pluginId, settingId, value),

  "Plugins.secretSet": ({ pluginId, settingId, value }) =>
    pluginSecretSet(pluginId, settingId, value),

  "Plugins.secretClear": ({ pluginId, settingId }) =>
    pluginSecretClear(pluginId, settingId),

  "Plugins.issueProviders": () => issueProviderDescriptors(),

  "Plugins.issueProviderList": ({ providerId, repository, search, mine }) =>
    issueProviderOperation(
      providerId,
      "listIssues",
      { repository, search, mine },
      Schema.Array(IssueSummary),
      (issues) => issues.map((issue) => issue.providerId),
    ),

  "Plugins.issueProviderGet": ({ providerId, repository, issueId }) =>
    issueProviderOperation(
      providerId,
      "getIssue",
      { repository, issueId },
      Schema.NullOr(IssueDetail),
      (issue) => (issue ? [issue.providerId] : []),
    ),

  "Plugins.issueProviderCreate": ({ providerId, repository, title, body }) =>
    issueProviderOperation(
      providerId,
      "createIssue",
      { repository, title, body },
      IssueDetail,
      (issue) => [issue.providerId],
    ),

  "Plugins.issueProviderAddComment": ({
    providerId,
    repository,
    issueId,
    body,
  }) =>
    issueProviderOperation(
      providerId,
      "addComment",
      { repository, issueId, body },
      IssueComment,
    ),

  "Plugins.authSessions": () => PluginAuth.list(),

  // An empty stream, not a failure: the renderer subscribes at startup and must
  // not spend its life retrying a channel that is merely quiet.
  "Plugins.events": () => Stream.empty,

  "Plugins.invoke": ({ pluginId, commandId, arg }) =>
    pluginHostOperation(pluginId, (host, plugin) =>
      host.invoke(plugin, commandId, arg),
    ),

  "Plugins.activate": ({ pluginId }) =>
    pluginHostOperation(pluginId, (host, plugin) => host.activate(plugin)),

  "Plugins.reload": ({ pluginId }) =>
    pluginHostOperation(pluginId, (host, plugin) => host.reload(plugin)),
  /**
   * Grant from the renderer — used by Settings to pre-authorise, and by the
   * e2e suite. The plugin-driven path goes through the extension host instead.
   */
  "Plugins.authGrant": ({ pluginId, providerId, scopes }) =>
    Effect.gen(function* () {
      const plugin = yield* enabledPluginById(pluginId);
      const session = yield* PluginAuth.getSession({
        pluginId,
        pluginName: plugin.manifest.name,
        providerId,
        scopes,
      });
      if (!session) return null;
      // Metadata only. The token stays in main — `AuthSessionInfo` has no field
      // for it, which is the boundary rather than an omission.
      const granted = yield* PluginAuth.list();
      return (
        granted.find(
          (g) => g.pluginId === pluginId && g.providerId === providerId,
        ) ?? null
      );
    }),

  "Plugins.authRevoke": ({ pluginId, providerId }) =>
    PluginAuth.revoke(pluginId, providerId),
});

const AssetListHandlersLayer = AssetListRpcs.toLayer({
  "Asset.list": (input) => assetList(input),
});

const HandlersLayer = Layer.mergeAll(
  CoreHandlersLayer,
  ReviewHandlersLayer,
  AssetListHandlersLayer,
);

/**
 * There is exactly one renderer. We remember its `WebContents` from the most
 * recent inbound frame so the server can push responses back to it. Requests
 * always arrive after the window has loaded, so this is set before any `send`.
 */
let sender: WebContents | null = null;

/**
 * A custom `RpcServer.Protocol` that pumps encoded frames over `ipcMain` /
 * `webContents.send`. `writeRequest` feeds an inbound client frame into the
 * server core; `send` ships a server response back to the renderer.
 */
const ServerProtocolLive = Layer.effect(
  RpcServer.Protocol,
  RpcServer.Protocol.make((writeRequest) =>
    Effect.gen(function* () {
      const disconnects = yield* Mailbox.make<number>();
      const runFork = Runtime.runFork(yield* Effect.runtime<never>());

      /**
       * Tell the server a renderer is gone, so it interrupts that client's
       * in-flight handler fibers and their finalizers run.
       *
       * Load-bearing, not hygiene. A handler's scope closes on a terminal
       * event, on a client `Interrupt` frame, or on this signal — and a
       * renderer that dies without unmounting (reload, HMR full reload, crash)
       * sends no Interrupt frame. The main process outlives it, so without
       * this the handler fiber runs forever holding whatever its finalizers
       * were meant to release. `AgentRunner`'s run reservation is exactly that:
       * a stranded one refuses the chat permanently with "already running",
       * and the reloaded renderer shows the chat idle, so there is no stop
       * button to clear it. Only killing the app recovered it.
       *
       * Listeners attach once per `WebContents` — `webContentsWatched` is
       * keyed by id because `sender` is reassigned on every inbound frame.
       */
      const webContentsWatched = new Set<number>();
      const watch = (contents: WebContents) => {
        if (webContentsWatched.has(contents.id)) return;
        webContentsWatched.add(contents.id);
        // Two teardown signals, on purpose. `disconnects` asks the RpcServer
        // to sweep the dead client's fibers — load-bearing for unary handlers
        // and the AgentRunner run reservation, but racy across a reload
        // because the reloaded page KEEPS this `WebContents.id`, so the sweep
        // and the new page's re-subscriptions contend on the same client id.
        // `firePageGone` closes that hole for the long-lived subscription
        // streams: it trips their interruption latch synchronously, before
        // the new document can boot, so their finalizers (fs.watch handles,
        // PubSub subscriptions, PTY consumers) always run exactly once per
        // page. Leaked instances of those were the dev-mode memory leak.
        const gone = () => {
          firePageGone();
          disconnects.unsafeOffer(contents.id);
        };
        contents.on("destroyed", () => {
          webContentsWatched.delete(contents.id);
          gone();
        });
        contents.on("render-process-gone", gone);
        // Covers reload: a reloading renderer keeps its `WebContents` (and so
        // its client id), so nothing else marks the old page's requests dead.
        // Same-document navigations are excluded — those keep the JS context,
        // and the client's fibers with it.
        contents.on("did-start-navigation", (details) => {
          if (details.isMainFrame && !details.isSameDocument) gone();
        });
      };

      ipcMain.on(RPC_CHANNEL, (event, data: FromClientEncoded) => {
        sender = event.sender;
        watch(event.sender);
        runFork(writeRequest(event.sender.id, data));
      });

      /**
       * `webContents.send` structured-clones its arguments. A frame carrying a
       * value the clone algorithm rejects throws `Failed to serialize
       * arguments` — and, uncaught here, that defect tears down the handler's
       * stream fiber. For the GitHub relay that is catastrophic: the stream
       * dies, its finalizer rejects the pending cursor acknowledgement, the
       * event is never acked, and the relay replays the same frame forever
       * (the "GitHub feedback relay is unavailable" reconnect loop). Worse, the
       * only trace was Electron's own stderr line, naming neither the RPC nor
       * the offending field.
       *
       * So we never let a single frame kill the transport: log it with enough
       * identity to find the culprit, then retry with a JSON-normalised copy.
       * Frames are JSON-safe by contract, so the round-trip is a no-op for
       * healthy frames and strips the stray non-cloneable value from a broken
       * one — the renderer still gets the frame, acks the cursor, and the loop
       * ends instead of spinning.
       */
      /**
       * A dead client is NOT a serialization failure. A reload/quit destroys
       * the WebContents while the server is still flushing that page's frames
       * — most of them the `Exit` acks of its own just-interrupted fibers —
       * and `send` then throws "Object has been destroyed" / "Render frame
       * was disposed". Treating those like broken payloads meant JSON-round-
       * tripping every (potentially multi-MB) frame, failing again, and
       * spamming the console once per interrupted stream on every reload.
       * There is no one to deliver to: drop them.
       */

      const sendServerFrame = (response: FromServerEncoded): void =>
        sendRpcServerFrame(sender, response);

      return {
        disconnects,
        send: (_clientId: number, response: FromServerEncoded) =>
          Effect.sync(() => sendServerFrame(response)),
        end: (_clientId: number) => Effect.void,
        clientIds: Effect.sync(() => new Set(sender ? [sender.id] : [])),
        initialMessage: Effect.succeed(Option.none()),
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
      };
    }),
  ),
);

/**
 * The running RPC server: the group's handlers served over the IPC protocol.
 * Building this layer forks the server daemon and registers the `ipcMain`
 * listener; `AppLayer` provides its Effect service requirements.
 *
 * `ContextManager` must be imported as a VALUE here even though this file never
 * calls it: it appears in the inferred requirement set via the handlers, and
 * TypeScript cannot NAME an inferred type that reaches into a workspace
 * package's internals without a reference to it in scope.
 */
const RpcServerLayer = RpcServer.layer(JinglerRpcs).pipe(
  Layer.provide(HandlersLayer),
  Layer.provide(ServerProtocolLive),
);

// Keep the large mapped handler context named at this module boundary. Letting
// TypeScript re-infer it through the runtime's long Layer.provide chain widens
// the input to `any` once the RPC group is large enough, defeating the final
// ManagedRuntime check. The assignment below also verifies this list stays a
// superset of every handler requirement.
export type RpcServerRequirements =
  | RoutinesService
  | AgentRunner
  | AgentRuntime
  | AppPaths
  | AssetService
  | AuthService
  | BackgroundTaskStore
  | BrowserControlMcpService
  | AgentTurnDriver
  | CommandExecutor.CommandExecutor
  | ConfigService
  | WebSearchCredentialService
  | ContextManager
  | DialogService
  | EnvironmentService
  | ExplanationStore
  | FileSystem.FileSystem
  | GitHubApi
  | GitHubAuth
  | GitHubEventStore
  | GitService
  | Path.Path
  | PluginAuth
  | PluginHost
  | PluginRegistry
  | PluginSecretStore
  | ProjectService
  | PreviewViewService
  | ReviewService
  | ReviewStore
  | RemoteSessionService
  | SecretStore
  | SessionStore
  | AgentResourceService
  | McpConfigService
  | TerminalService
  | ThemeService
  | TranscriptStore
  | UsageService
  | WorkspaceService
  | WorkspaceWorkflowService
  | WorkspaceCheckpointService
  | RuntimeDiagnostics
  | RuntimeRecoveryService
  | ProviderConnections;
export const RpcServerLive: Layer.Layer<never, never, RpcServerRequirements> =
  RpcServerLayer;

const clientGone = (error: unknown): boolean =>
        error instanceof Error && /destroyed|disposed/i.test(error.message);

const sendRpcServerFrame = (target: WebContents | null, response: FromServerEncoded): void => {
  if (target === null || target.isDestroyed()) return;
  try {
    target.send(RPC_CHANNEL, response);
  } catch (error) {
    if (clientGone(error)) return;
    const frame = response as {
      readonly _tag?: string;
      readonly requestId?: unknown;
    };
    console.error(
      `[rpc] server frame failed to serialize (tag=${frame._tag ?? "?"} requestId=${String(frame.requestId ?? "?")}); retrying JSON-normalised`,
      error,
    );
    recordSerializationFailure(response, frame, error);
    try {
      if (!target.isDestroyed()) {
        target.send(
          RPC_CHANNEL,
          JSON.parse(JSON.stringify(response)) as FromServerEncoded,
        );
      }
    } catch (fallbackError) {
      if (!clientGone(fallbackError)) {
        console.error(
          "[rpc] server frame is unrecoverable; dropping it to keep the transport alive",
          fallbackError,
        );
      }
    }
  }
};

function decodeRemotePublishResult<A, I>(operation: string, schema: Schema.Schema<A, I, never>) {
  return (events: Iterable<import("@jingler/core").RemoteSessionEvent>) => {
    const terminal = Array.from(events).at(-1);
    if (!terminal || terminal.kind === "failed") {
      const message = terminal?.payload &&
        typeof terminal.payload === "object" &&
        "message" in terminal.payload &&
        typeof terminal.payload.message === "string"
        ? terminal.payload.message
        : `Remote ${operation} failed.`;
      return Effect.fail(new Error(message));
    }
    if (terminal.kind !== "complete") {
      return Effect.fail(
        new Error(`Remote ${operation} did not complete.`)
      );
    }
    return Schema.decodeUnknown(schema)(
      terminal.payload
    ).pipe(
      Effect.mapError(
        () => new Error(
          `Remote ${operation} returned an invalid result.`
        )
      )
    );
  };
}

const continueWorkspace = (source: Session, target: string | undefined, environments: EnvironmentService, remote: RemoteSessionService) => Effect.gen(function* () {
  const sourceMessages = yield* TranscriptStore.list(
    source.activeChatId,
  ).pipe(Effect.orElseSucceed(() => []));
  const checkpoint = yield* continuationCheckpoint(source, sourceMessages.length, remote);
  const { targetEnvironment, targetRepository, targetBaseBranch } = yield* resolveContinuationTarget(source, checkpoint, target, environments);
  if (
    source.connectionId === undefined ||
    source.providerId === undefined ||
    source.modelId === undefined
  ) {
    return yield* Effect.fail(
      new EnvironmentHandoffError({
        reason: "unavailable",
        message:
          "Choose a provider connection before continuing this session.",
        sessionId: source.id,
        ...(target === undefined ? {} : { environmentId: target }),
      }),
    );
  }
  if (target === undefined) {
    return yield* continueLocalWorkspace(source, targetRepository!, targetBaseBranch, checkpoint, sourceMessages);
  }
  const requestedSessionId = yield* prepareManagedContinuation(
    targetEnvironment, target, source, checkpoint, environments
  );
  return yield* admitRemoteContinuation(source, target, requestedSessionId, targetRepository, targetBaseBranch, checkpoint, sourceMessages, remote)
});

const continuationCheckpoint = (source: Session, eventCursor: number, remote: RemoteSessionService) =>
  source.environmentId === undefined
    ? source.worktreePath
      ? Effect.tryPromise({
        try: () =>
          exportWorkspaceHandoff({
            workspacePath: source.worktreePath!,
            sourceSessionId: source.id,
            eventCursor: eventCursor,
          }),
        catch: (cause) =>
          new EnvironmentHandoffError({
            reason: "unavailable",
            message:
              "The source workspace could not be checkpointed.",
            sessionId: source.id,
          }),
      })
      : Effect.fail(
        new EnvironmentHandoffError({
          reason: "unavailable",
          message: "The source session has no workspace to hand off.",
          sessionId: source.id,
        }),
      )
    : remote
      .request(source, "Workspace.exportHandoff", {
        eventCursor: eventCursor,
      })
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknown(WorkspaceTransferCheckpointSchema),
        ),
        Effect.mapError(
          (cause) =>
            new EnvironmentHandoffError({
              reason: "unavailable",
              message:
                "The source environment could not checkpoint the workspace.",
              sessionId: source.id,
              environmentId: source.environmentId,
            }),
        ),
      );

const prepareManagedContinuation = (
  targetEnvironment: Environment | undefined,
  target: string,
  source: Session,
  checkpoint: WorkspaceTransferCheckpoint,
  environments: EnvironmentService
) => Effect.gen(function* () {
  let requestedSessionId: string | undefined;
  if (targetEnvironment?.kind === "managed") {
    if (!environmentRuntimeIsCurrent(targetEnvironment)) {
      return yield* Effect.fail(
        new EnvironmentHandoffError({
          reason: "incompatible",
          message:
            "Cloud is running an incompatible agent runtime. Update Cloud before continuing this pi session.",
          sessionId: source.id,
          environmentId: target,
        }),
      );
    }
    if (checkpoint.repositorySlug === null) {
      return yield* Effect.fail(
        new EnvironmentHandoffError({
          reason: "unavailable",
          message:
            "Managed handoff requires a GitHub repository identity.",
          sessionId: source.id,
          environmentId: target,
        }),
      );
    }
    requestedSessionId = `s_cloud_${randomBytes(18).toString("base64url")}`;
    yield* environments
      .hydrateManagedWorkspace(
        targetEnvironment,
        requestedSessionId,
        createWorkspaceProvisioningPlan({
          githubSlug: checkpoint.repositorySlug,
          headSha: checkpoint.headSha,
          branch: checkpoint.branch ?? source.baseBranch ?? "main",
          baseBranch: source.baseBranch ?? checkpoint.branch ?? "main",
          createBranch: false,
          source: {
            kind: "handoff",
            sourceSessionId: source.id,
            checkpointId: checkpoint.checkpointId,
            eventCursor: checkpoint.eventCursor,
          },
        }),
        {
          connectionId: source.connectionId!,
          providerId: source.providerId!,
          modelId: source.modelId!,
        },
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentHandoffError({
              reason: "unavailable",
              message:
                "The managed target could not verify the source Git base.",
              sessionId: source.id,
              environmentId: target,
            }),
        ),
      );
  }

  return requestedSessionId;
});

const continueLocalWorkspace = (
  source: Session,
  targetRepository: ContinuationRepository,
  targetBaseBranch: string,
  checkpoint: WorkspaceTransferCheckpoint,
  sourceMessages: ReadonlyArray<Message>
) => Effect.gen(function* () {
  const created = yield* createSession({
    repoPath: targetRepository!.path,
    repoName: targetRepository!.name,
    connectionId: source.connectionId!,
    providerId: source.providerId!,
    modelId: source.modelId!,
    baseBranch: targetBaseBranch,
    title: `${source.title} continuation`,
  }).pipe(
    Effect.mapError(
      () =>
        new EnvironmentHandoffError({
          reason: "unavailable",
          message:
            "The desktop could not provision the continuation workspace.",
          sessionId: source.id,
        }),
    ),
  );
  if (!created.worktreePath) {
    return yield* Effect.fail(
      new EnvironmentHandoffError({
        reason: "unavailable",
        message: "The local continuation has no verified workspace.",
        sessionId: source.id,
      }),
    );
  }
  yield* Effect.tryPromise({
    try: async () => {
      await checkoutWorkspaceHandoffBase(
        created.worktreePath!,
        checkpoint,
      );
      await importWorkspaceHandoff(created.worktreePath!, checkpoint);
    },
    catch: (cause) =>
      new EnvironmentHandoffError({
        reason: "unavailable",
        message:
          "The local continuation did not match the source checkpoint.",
        sessionId: source.id,
      }),
  });
  for (const message of sourceMessages) {
    yield* TranscriptStore.append(created.activeChatId, message);
  }
  return created;
});

const admitRemoteContinuation = (source: Session, target: string, requestedSessionId: string | undefined, targetRepository: ContinuationRepository | null, targetBaseBranch: string, checkpoint: WorkspaceTransferCheckpoint, sourceMessages: ReadonlyArray<Message>, remote: RemoteSessionService) => Effect.gen(function* () {
  const targetSession = requestedSessionId
    ? {
      id: requestedSessionId,
      environmentId: target,
      connectionId: source.connectionId,
      providerId: source.providerId,
      modelId: source.modelId,
    }
    : null;
  const value = yield* (
    targetSession
      ? remote.request(
        targetSession,
        "Sessions.continueOnEnvironment",
        {
          sourceSession: {
            ...source,
            title: `${source.title} continuation`,
            environmentId: target,
            repo: targetRepository?.name ?? source.repo,
            repoPath: "/workspace",
            worktreePath: undefined,
            baseBranch: targetBaseBranch,
          },
          requestedSessionId,
        },
      )
      : remote.requestOnEnvironment(
        target,
        "Sessions.continueOnEnvironment",
        {
          sourceSession: {
            ...source,
            title: `${source.title} continuation`,
            environmentId: target,
            repo: targetRepository!.name,
            repoPath: targetRepository!.path,
            worktreePath: undefined,
            baseBranch: targetBaseBranch,
          },
        },
      )
  ).pipe(
    Effect.mapError(
      () =>
        new EnvironmentHandoffError({
          reason: "unavailable",
          message:
            "The target device did not admit a continuation workspace.",
          sessionId: source.id,
          environmentId: target,
        }),
    ),
  );
  const created = yield* Schema.decodeUnknown(SessionSchema)(
    value,
  ).pipe(
    Effect.mapError(
      () =>
        new EnvironmentHandoffError({
          reason: "unavailable",
          message:
            "The target device returned invalid continuation metadata.",
          sessionId: source.id,
          environmentId: target,
        }),
    ),
  );
  if (created.environmentId !== target) {
    return yield* Effect.fail(
      new EnvironmentHandoffError({
        reason: "unavailable",
        message:
          "The remote device returned a continuation for a different environment.",
        sessionId: source.id,
        environmentId: target,
      }),
    );
  }
  yield* remote
    .request(created, "Workspace.importHandoff", { checkpoint })
    .pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentHandoffError({
            reason: "unavailable",
            message:
              "The target workspace did not verify the source checkpoint.",
            sessionId: source.id,
            environmentId: target,
          }),
      ),
    );
  yield* remote
    .request(created, "Sessions.importConversation", {
      messages: sourceMessages,
    })
    .pipe(
      Effect.mapError(
        () =>
          new EnvironmentHandoffError({
            reason: "unavailable",
            message:
              "The target session could not restore the source conversation.",
            sessionId: source.id,
            environmentId: target,
          }),
      ),
    );
  return yield* SessionStore.upsertRemote(created).pipe(
    Effect.mapError(
      () =>
        new EnvironmentHandoffError({
          reason: "unavailable",
          message:
            "The desktop could not persist the remote continuation.",
          sessionId: source.id,
          environmentId: target,
        }),
    ),
  );
})

function recordSerializationFailure(
  response: FromServerEncoded,
  frame: { readonly _tag?: string; readonly requestId?: unknown },
  error: unknown
): void {
  // DIAGNOSTIC (temporary): record the offending frame so the culprit RPC
  // and payload shape are recoverable — this reproduces on bot/automation
  // PR comments (e.g. Devin). JSON survives values structured-clone
  // rejects (functions/symbols), so it still names the frame.
  try {
    let preview: string;
    try {
      preview = JSON.stringify(response) ?? "undefined";
    } catch (previewError) {
      preview = `<unstringifiable: ${String(previewError)}>`;
    }
    appendFileSync(
      "/tmp/jingler-relay-diag.log",
      `[${new Date().toISOString()}] serialize-fail tag=${frame._tag ?? "?"} requestId=${String(frame.requestId ?? "?")} error=${String(error)} frame=${preview.slice(0, 6000)}\n`,
    );
  } catch {
    // diagnostics must never throw
  }
}

function remoteProvisioningSource(
  operation: "Sessions.create" | "Sessions.createFromPr" | "Sessions.createFromIssue",
  input: CreateSessionInput | CreateSessionFromPrInput | CreateSessionFromIssueInput
) {
  if (operation === "Sessions.createFromPr") {
    const { pr } = input as CreateSessionFromPrInput;
    return { branch: pr.headRefName, baseBranch: pr.baseRefName, source: { kind: "pull-request" as const, pullRequestNumber: pr.number } };
  }
  const { baseBranch } = input as CreateSessionInput | CreateSessionFromIssueInput;
  return { branch: baseBranch, baseBranch, source: { kind: "new" as const } };
}

const resolveContinuationTarget = (source: Session, checkpoint: WorkspaceTransferCheckpoint, target: string | undefined, environments: EnvironmentService) => Effect.gen(function* () {
  const sourceRepositories = yield* continuationRepositories(
    environments,
    source.environmentId,
  ).pipe(Effect.orElseSucceed(() => []));
  const sourceRepository =
    sourceRepositories.find(
      (candidate) => candidate.path === source.repoPath,
    ) ??
    sourceRepositories.find(
      (candidate) => candidate.name === source.repo,
    );
  const sourceIdentity = {
    name: sourceRepository?.name ?? source.repo,
    githubSlug:
      checkpoint.repositorySlug ?? sourceRepository?.githubSlug ?? null,
  };
  const targetEnvironment =
    target === undefined
      ? undefined
      : yield* environments.environment(target).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentHandoffError({
              reason: "unavailable",
              message:
                "The target environment is no longer available.",
              sessionId: source.id,
              environmentId: target,
            }),
        ),
      );
  const targetRepositories = yield* continuationRepositories(
    environments,
    target,
  ).pipe(
    targetEnvironment?.kind === "managed"
      ? Effect.orElseSucceed(() => [])
      : (effect) => effect,
    Effect.mapError(
      () =>
        new EnvironmentHandoffError({
          reason: "unavailable",
          message:
            "The target environment could not list its repositories.",
          sessionId: source.id,
          ...(target === undefined ? {} : { environmentId: target }),
        }),
    ),
  );
  const targetRepository = selectContinuationRepository(
    sourceIdentity,
    targetRepositories,
  );
  if (
    targetRepository === null &&
    targetEnvironment?.kind !== "managed"
  ) {
    return yield* Effect.fail(
      new EnvironmentHandoffError({
        reason: "unavailable",
        message: `${sourceIdentity.githubSlug ?? sourceIdentity.name} is not available on the target environment.`,
        sessionId: source.id,
        ...(target === undefined ? {} : { environmentId: target }),
      }),
    );
  }
  const targetBaseBranch =
    source.baseBranch ??
    targetRepository?.defaultBranch ??
    source.branch;

  return { targetEnvironment, targetRepository, targetBaseBranch };
});

const managedRepositoryIdentity = (repoPath: string) => Effect.gen(function* () {
  const remoteUrl = yield* GitService.remoteUrl(repoPath);
  const repository = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
  if (!repository) {
    return yield* Effect.fail(
      new GitError({
        message:
          "Managed environments currently require a GitHub repository remote.",
      }),
    );
  }
  return repository;
});
