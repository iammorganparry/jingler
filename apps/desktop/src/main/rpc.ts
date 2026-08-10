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
  AgentRunner,
  AppPaths,
  AssetService,
  AuthService,
  BrowserControlMcpService,
  type CliAdapter,
  ConfigService,
  claudeTitleGenerator,
  DiscoveryService,
  EnvironmentService,
  RemoteSessionService,
  routeSessionOperation,
  filterVisible,
  GitHubApi,
  GitHubAuth,
  githubPushPermissions,
  GitHubEventStore,
  GitService,
  ModelsService,
  MemoryService,
  type MemoryServiceEnvironment,
  attachMemoryToSessionSpec,
  OpenConnectorService,
  OpenConnectorApi,
  SecretStore,
  SecretStoreUnavailable,
  planDraftPost,
  billingPath,
  subscriptionProbeFailed,
  hasSubscriptionAuth,
  resetSubscriptionCache,
  METERED_ENV_KEYS,
  PlanStore,
  PluginRegistry,
  PluginSecretStore,
  type PluginSecretStoreUnavailable,
  PluginHost,
  type PluginHostRuntime,
  PluginAuth,
  ProjectService,
  planReviewPost,
  retitleSession,
  ReviewService,
  ReviewStore,
  SessionStore,
  setSessionEnvironment,
  continueSessionOnEnvironment,
  ContextManager,
  SkillsService,
  TerminalService,
  ThemeService,
  BackgroundTaskStore,
  TranscriptStore,
  claudePublishMetadataGenerator,
  isCommitSubjectSafe,
  isSessionPublishBranchReady,
  runPublishMachineExclusive,
  UsageService,
  WorkspaceService,
} from "@jingler/cli-adapters";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  AuthError,
  ConfigError,
  ConnectorError,
  defaultModeFor,
  GitHubApiError,
  GitError,
  IssueComment,
  IssueDetail,
  IssueReference,
  IssueSummary,
  issueReferenceOf,
  PlanConflictError,
  PlanPersistenceError,
  type PlanValidationError,
  resolveFindings,
  ReviewError,
  reviewModelFor,
  PluginError,
  SessionNotFoundError,
  workspaceModeOf,
  Environment as EnvironmentSchema,
  EnvironmentHandoffError,
  StreamEvent as StreamEventSchema,
  Message as MessageSchema,
  Session as SessionSchema,
  PublishCheckpoint as PublishCheckpointSchema,
  Project as ProjectSchema,
  RemotePublishPrepared as RemotePublishPreparedSchema,
} from "@jingler/core";
import type {
  BrowserBounds,
  AdversarialReview,
  CliKind,
  OpenConnectorConfig,
  OpenConnectorDefaults,
  StreamEvent,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  IssueAutomations,
  Message,
  PlanCommentMentionDelivery,
  PlanCommentMessageDeliveryState,
  PlanDocument,
  PlanMentionDelivery,
  PermissionMode,
  PluginCatalog,
  LoadedPlugin,
  PluginSettingValue,
  PluginSettingsSnapshot,
  SettingContribution,
  PrMergeMethod,
  PublishCheckpoint,
  ProviderConfig,
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
  SettledSessionStatus,
  WorkspaceConfig,
} from "@jingler/core";
import type {
  GitHubRepository,
  SessionSpec,
} from "@jingler/cli-adapters";
import {
  AssetListRpcs,
  JinglerCoreRpcs,
  JinglerReviewRpcs,
  JinglerRpcs,
  MemoryAccess as MemoryAccessSchema,
  MemoryDashboardSummary as MemoryDashboardSummarySchema,
  MemoryEdgeEvidence as MemoryEdgeEvidenceSchema,
  MemoryGraphView as MemoryGraphViewSchema,
  MemoryPageDetail as MemoryPageDetailSchema,
  MemorySuggestionsView as MemorySuggestionsViewSchema,
  MemoryUiError,
} from "@jingler/contracts";
import { FileSystem, Path } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform";
import { RpcServer } from "@effect/rpc";
import type {
  FromClientEncoded,
  FromServerEncoded,
} from "@effect/rpc/RpcMessage";
import {
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
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { showNotification, shouldNotify } from "./notifications.js";
import { PreviewViewService } from "./preview-view.js";
import { DialogService } from "./dialog.js";
import { createZipArchive } from "./zip.js";
import {
  dialGitHubRelay,
  GitHubRelayConnection,
  GitHubRelaySupervisor,
  installationCanRouteRepository,
} from "./github-relay.js";

/** The single IPC channel both directions of the RPC transport ride on. */
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
): Effect.Effect<void> =>
  Effect.sync(() => {
    const key = relayAcknowledgementKey(clientId, cursor);
    const pending = pendingRelayAcknowledgements.get(key);
    if (!pending) return;
    pendingRelayAcknowledgements.delete(key);
    pending.resolve();
  });

export const githubConnectionStatus = (): Effect.Effect<
  GitHubAppConnectionStatus,
  AuthError,
  GitHubAuth
> => GitHubAuth.status().pipe(Effect.mapError(githubConnectionError));

export const githubRepositories = () =>
  GitHubAuth.repositories().pipe(Effect.mapError(githubConnectionError));

export const githubConnectionRefresh = (): Effect.Effect<
  GitHubAppConnectionStatus,
  AuthError,
  GitHubAuth
> => GitHubAuth.refresh().pipe(Effect.mapError(githubConnectionError));

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

const MemoryBackendSearch = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      pageId: Schema.String,
      revisionId: Schema.String,
      revision: Schema.Number,
      path: Schema.String,
      title: Schema.String,
      snippet: Schema.String,
    }),
  ),
});

const MemoryBackendPage = Schema.Struct({
  page: Schema.Struct({
    id: Schema.String,
    path: Schema.String,
    title: Schema.String,
    revision: Schema.Number,
    aliases: Schema.Array(Schema.String),
    tags: Schema.Array(Schema.String),
    body: Schema.String,
    citations: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        sourceId: Schema.String,
        locator: Schema.optional(Schema.String),
        quote: Schema.optional(Schema.String),
      }),
    ),
  }),
  revision: Schema.Struct({
    id: Schema.String,
    pageId: Schema.String,
    revision: Schema.Number,
    authorId: Schema.String,
    createdAt: Schema.String,
    acceptedAt: Schema.String,
  }),
  sourceIds: Schema.Array(Schema.String),
  citationIds: Schema.Array(Schema.String),
  backlinks: Schema.Array(Schema.String),
});

const MemoryBackendSuggestions = Schema.Struct({
  version: Schema.Literal(1),
  vectorSource: Schema.Literal("turbopuffer", "lexical"),
  suggestions: Schema.Array(
    Schema.Struct({
      sourceId: Schema.String,
      targetId: Schema.String,
      method: Schema.Literal("lexical", "embedding"),
      score: Schema.Number,
      evidence: Schema.Struct({
        method: Schema.Literal("lexical", "embedding"),
        cosine: Schema.Number,
        sharedTerms: Schema.optional(Schema.Array(Schema.String)),
        sharedTags: Schema.optional(Schema.Array(Schema.String)),
        sharedSources: Schema.optional(Schema.Array(Schema.String)),
        sharedSchemas: Schema.optional(Schema.Array(Schema.String)),
        model: Schema.optional(Schema.String),
        neighborRank: Schema.optional(Schema.Number),
      }),
    }),
  ),
});

const MemoryBackendExport = Schema.Struct({
  format: Schema.Literal("jingler-obsidian-vault"),
  version: Schema.Literal(1),
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, content: Schema.String }),
  ),
});

const memoryUiFailure = (message: string, status = 503): MemoryUiError =>
  new MemoryUiError({ message, status });

const decodeMemory = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
  message: string,
): Effect.Effect<A, MemoryUiError> =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(() => memoryUiFailure(message, 502)),
  );

const memoryTool = (
  organizationId: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
) =>
  Effect.flatMap(MemoryService, (service) =>
    service
      .uiRequest({ organizationId, name, arguments: args })
      .pipe(
        Effect.flatMap((value) =>
          value === null
            ? Effect.fail(
                memoryUiFailure("Team memory is unavailable or unauthorized"),
              )
            : Effect.succeed(value),
        ),
      ),
  );

const memoryAccess = () =>
  Effect.flatMap(MemoryService, (service) => service.access()).pipe(
    Effect.flatMap((access) =>
      decodeMemory(
        MemoryAccessSchema,
        access === null
          ? { eligible: false, selectedOrganizationId: null, organizations: [] }
          : {
              eligible: access.organizations.length > 0,
              selectedOrganizationId: access.selectedOrganizationId,
              organizations: access.organizations,
            },
        "Memory access response was invalid",
      ),
    ),
  );

const memoryRecover = () =>
  Effect.flatMap(MemoryService, (service) => service.recoverCaptures()).pipe(
    Effect.flatMap((result) =>
      result === null
        ? Effect.fail(
            memoryUiFailure(
              "Memory recovery requires an enabled organization",
              401,
            ),
          )
        : Effect.succeed(result),
    ),
  );

const memoryDashboard = (organizationId: string, range: string) =>
  memoryTool(organizationId, "memory_dashboard", { range }).pipe(
    Effect.flatMap((value) =>
      decodeMemory(
        MemoryDashboardSummarySchema,
        value,
        "Memory dashboard response was invalid",
      ),
    ),
  );

const memoryGraph = (organizationId: string, limit: number) =>
  memoryTool(organizationId, "memory_graph", {
    limit: Math.min(250, Math.max(1, limit)),
  }).pipe(
    Effect.flatMap((value) =>
      decodeMemory(
        MemoryGraphViewSchema,
        value,
        "Memory graph response was invalid",
      ),
    ),
  );

const memoryNeighborhood = (
  organizationId: string,
  nodeId: string,
  limit: number,
) =>
  memoryTool(organizationId, "memory_graph_neighborhood", {
    nodeId,
    limit: Math.min(100, Math.max(1, limit)),
  }).pipe(
    Effect.flatMap((value) =>
      decodeMemory(
        MemoryGraphViewSchema,
        value,
        "Memory neighborhood response was invalid",
      ),
    ),
  );

const memoryEvidence = (organizationId: string, edgeId: string) =>
  memoryTool(organizationId, "memory_edge_evidence", { edgeId }).pipe(
    Effect.flatMap((value) =>
      decodeMemory(
        MemoryEdgeEvidenceSchema,
        value,
        "Memory edge evidence response was invalid",
      ),
    ),
  );

const memorySearch = (organizationId: string, query: string, limit: number) =>
  memoryTool(organizationId, "memory_search", {
    query,
    limit: Math.min(100, Math.max(1, limit)),
  }).pipe(
    Effect.flatMap((value) =>
      decodeMemory(
        MemoryBackendSearch,
        value,
        "Memory search response was invalid",
      ),
    ),
    Effect.map((response) =>
      response.results.map((result) => ({
        pageId: result.pageId,
        path: result.path,
        title: result.title,
        revisionId: result.revisionId,
        snippet: result.snippet,
      })),
    ),
  );

const memoryPage = (organizationId: string, pageId: string) =>
  Effect.all(
    {
      page: memoryTool(organizationId, "memory_read", { pageId }).pipe(
        Effect.flatMap((value) =>
          decodeMemory(
            MemoryBackendPage,
            value,
            "Memory page response was invalid",
          ),
        ),
      ),
      neighborhood: memoryNeighborhood(
        organizationId,
        `page:${pageId}`,
        100,
      ).pipe(Effect.orElseSucceed(() => null)),
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap(({ page, neighborhood }) => {
      const node = neighborhood?.nodes.find(
        (candidate) => candidate.pageId === pageId,
      );
      return decodeMemory(
        MemoryPageDetailSchema,
        {
          ...page,
          backlinks: page.backlinks,
          contributors: [page.revision.authorId],
          health: node?.health ?? {
            brokenLinks: 0,
            contradictions: 0,
            orphan: true,
          },
        },
        "Memory page detail was invalid",
      );
    }),
  );

export const memoryExport = (organizationId: string) =>
  Effect.gen(function* () {
    const filename = `jingler-memory-${organizationId}.zip`;
    const dialog = yield* DialogService;
    const destination = yield* dialog.saveFile({
      title: "Export team memory",
      defaultPath: filename,
    });
    if (destination === null) return { filename, saved: false };
    const value = yield* memoryTool(organizationId, "memory_export", {});
    const vault = yield* decodeMemory(
      MemoryBackendExport,
      value,
      "Memory vault export was invalid",
    );
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFile(destination, createZipArchive(vault.files));
    return { filename, saved: true };
  }).pipe(Effect.mapError(() => memoryUiFailure("Memory vault export failed")));

const memoryRpcRequest = (input: {
  readonly organizationId?: string;
  readonly operation:
    | "access"
    | "dashboard"
    | "graph"
    | "neighborhood"
    | "edgeEvidence"
    | "search"
    | "page"
    | "recover"
    | "export";
  readonly range?: string;
  readonly limit?: number;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly query?: string;
  readonly pageId?: string;
}) => {
  const organizationId = input.organizationId ?? "";
  switch (input.operation) {
    case "access":
      return memoryAccess();
    case "dashboard":
      return memoryDashboard(organizationId, input.range ?? "all");
    case "graph":
      return memoryGraph(organizationId, input.limit ?? 250);
    case "neighborhood":
      return memoryNeighborhood(
        organizationId,
        input.nodeId ?? "",
        input.limit ?? 100,
      );
    case "edgeEvidence":
      return memoryEvidence(organizationId, input.edgeId ?? "");
    case "search":
      return memorySearch(organizationId, input.query ?? "", input.limit ?? 50);
    case "page":
      return memoryPage(organizationId, input.pageId ?? "");
    case "recover":
      return memoryRecover();
    case "export":
      return memoryExport(organizationId);
  }
};

/**
 * `Memory.suggestions` handler — advisory relatedness only. A NEW, separate path
 * from `memoryRpcRequest`: it fetches suggestions through the hosted grant (which
 * stays in the main process), optionally scopes them to a page, and maps ids to
 * best-effort titles. It never touches the accepted graph or an edge endpoint.
 */
const memorySuggestions = (
  organizationId: string,
  pageId: string | undefined,
  limit: number,
) =>
  Effect.flatMap(MemoryService, (service) =>
    service
      .suggestions({
        organizationId,
        ...(pageId === undefined || pageId === "" ? {} : { pageId }),
        limit: Math.min(50, Math.max(1, limit)),
      })
      .pipe(
        Effect.flatMap((value) =>
          value === null
            ? Effect.fail(
                memoryUiFailure("Team memory is unavailable or unauthorized"),
              )
            : Effect.succeed(value),
        ),
      ),
  ).pipe(
    Effect.flatMap((value) =>
      decodeMemory(
        MemoryBackendSuggestions,
        value,
        "Memory suggestions response was invalid",
      ),
    ),
    Effect.flatMap((view) => {
      return decodeMemory(
        MemorySuggestionsViewSchema,
        {
          version: 1,
          vectorSource: view.vectorSource,
          suggestions: view.suggestions.map((link) => ({
            sourceId: link.sourceId,
            targetId: link.targetId,
            method: link.method,
            score: link.score,
            sourceTitle: link.sourceId,
            targetTitle: link.targetId,
            evidence: link.evidence,
          })),
        },
        "Memory suggestions view was invalid",
      );
    }),
  );

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

/**
 * `Skills.list` handler. Resolves the session's harness + worktree (best-effort;
 * an unknown session falls back to Claude with no worktree) so `SkillsService`
 * can report the harness-appropriate skills for the `/` menu. Exported for tests.
 */
export const skillsList = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId).pipe(
      Effect.orElseSucceed(() => null),
    );
    const cli = session?.cli ?? "claude";
    // The harness announces its own command list, so we need the binary discovery
    // resolved — a GUI-launched Electron app has a threadbare PATH, so the bare
    // name often isn't runnable (same reason `Models.list` takes it).
    const clis = yield* DiscoveryService.list().pipe(
      Effect.orElseSucceed(() => []),
    );
    return yield* SkillsService.list({
      cli,
      // The operator's global skills live under the real home (~/.claude/skills),
      // never JINGLER_HOME.
      homeDir: homedir(),
      worktreePath: session?.worktreePath ?? null,
      binPath: clis.find((c) => c.kind === cli)?.binPath ?? null,
    });
  });

/**
 * The Jingler-hosted OpenConnector URL used by packaged (prod) builds, overridable
 * via env for staging. PLACEHOLDER until the hosted instance ships — the mechanism
 * is here so prod points at it automatically the moment the URL is real.
 */
const HOSTED_OPEN_CONNECTOR_URL =
  process.env.JINGLER_OPEN_CONNECTOR_URL ?? "https://connect.jingler.app";

/** The dev instance the repo-root docker-compose serves, with its zero-setup token. */
const DEV_OPEN_CONNECTOR_URL =
  process.env.OPEN_CONNECTOR_BASE_URL ?? "http://localhost:3000";
const DEV_OPEN_CONNECTOR_TOKEN =
  process.env.OPEN_CONNECTOR_API_TOKEN ?? "local-dev-token";

/**
 * Environment-aware onboarding defaults. Only the main process knows
 * `app.isPackaged`, so this lives here rather than in the cli-adapters service.
 */
export const openConnectorDefaults = (): OpenConnectorDefaults =>
  // `app?.` because the unit-test env has no Electron `app`; there, dev is correct.
  app?.isPackaged
    ? {
        endpoint: HOSTED_OPEN_CONNECTOR_URL,
        kind: "hosted",
        hasDevToken: false,
      }
    : { endpoint: DEV_OPEN_CONNECTOR_URL, kind: "local", hasDevToken: true };

/** `OpenConnector.get` handler — settings + a `hasToken` bool + onboarding defaults. */
export const openConnectorGet = () =>
  OpenConnectorService.get.pipe(
    Effect.map((r) => ({ ...r, defaults: openConnectorDefaults() })),
  );

/**
 * `OpenConnector.autoSetup` handler — one-click onboarding. Dev fills the local
 * endpoint + dev token and enables; prod points at the hosted endpoint but leaves
 * it disabled (its token is provisioned separately — see docs/open-connector.md).
 */
export const openConnectorAutoSetup = () => {
  const d = openConnectorDefaults();
  const config = {
    endpoint: d.endpoint,
    enabled: d.kind === "local",
    serverName: "open-connector",
    preferJinglerTools: true,
  };
  return openConnectorSet(
    config,
    d.hasDevToken ? DEV_OPEN_CONNECTOR_TOKEN : undefined,
  );
};

/**
 * `OpenConnector.set` handler. The token can fail to persist when the OS vault is
 * unavailable; that surfaces as `SecretStoreUnavailable`, which is not an RPC
 * error type, so it's folded into `ConfigError` (the channel the panel handles).
 */
export const openConnectorSet = (
  config: OpenConnectorConfig,
  token: string | null | undefined,
) =>
  OpenConnectorService.set(config, token).pipe(
    Effect.catchIf(
      (e): e is SecretStoreUnavailable => e instanceof SecretStoreUnavailable,
      (e) => new ConfigError({ message: e.message, cause: e }),
    ),
  );

/** `OpenConnector.test` handler — live probe of the configured endpoint. */
export const openConnectorTest = () => OpenConnectorService.test;

/**
 * `OpenConnector.injection` handler — what each harness would actually launch with,
 * resolved by the same service method the agent runner calls.
 */
export const openConnectorInjection = () =>
  OpenConnectorService.injectionTargets;

// ── MCP Connector Center handlers ────────────────────────────────────────────

/** `Connector.startOauth` — begin OAuth, opening the consent URL in the system browser. */
export const connectorStartOauth = (
  service: string,
  connectionName: string | undefined,
) =>
  OpenConnectorApi.startAuthorization(service, connectionName).pipe(
    // The URL can carry a `state` secret, so it is opened in the main process and
    // never returned to the renderer; OpenConnector's own callback stores the grant.
    Effect.flatMap((url) =>
      // The URL is remote-controlled (the OpenConnector instance's response), and
      // `openExternal` will launch ANY protocol handler — file://, custom schemes.
      // Refuse anything but http(s), mirroring `index.ts`'s deep-link guard, so a
      // compromised or MITM'd instance can't drive an arbitrary-URL open.
      /^https?:\/\//i.test(url)
        ? Effect.tryPromise({
            try: () => shell.openExternal(url),
            catch: () =>
              new ConnectorError({
                message: "Couldn't open the authorization URL.",
              }),
          })
        : Effect.fail(
            new ConnectorError({
              message:
                "OpenConnector returned a non-http(s) authorization URL.",
            }),
          ),
    ),
    Effect.as({ ok: true, message: null } as const),
  );

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
    if (!session?.worktreePath) return "";
    return yield* WorkspaceService.diff(session.worktreePath);
  });

/** Resolve a session (best-effort; unknown → null) for the GitHub handlers. */
const resolveSession = (sessionId: string) =>
  SessionStore.get(sessionId).pipe(Effect.orElseSucceed(() => null));

type SessionWithPr = Session & { readonly prNumber: number };

const hasActivePr = (session: Session | null): session is SessionWithPr =>
  session !== null && session.prNumber !== null;

const providerReasoning = (
  provider: ProviderConfig | undefined,
): ReasoningSetting | undefined => {
  if (
    provider === undefined ||
    (provider.thinkingEnabled === undefined &&
      provider.reasoningEffort === undefined)
  ) {
    return;
  }
  return {
    enabled: provider.thinkingEnabled ?? true,
    ...(provider.reasoningEffort === undefined
      ? {}
      : { effort: provider.reasoningEffort }),
  };
};

/** Shared route/default policy for blank, PR, and issue session creation. */
export const sessionCreationDefaults = (
  requestedCli: CliKind,
  config: WorkspaceConfig | null,
  requestedModel?: string,
  requestedMode?: PermissionMode,
  requestedReasoning?: ReasoningSetting | null,
) => {
  const cli = requestedCli;
  const provider = config?.providers?.[cli];
  return {
    cli,
    options: {
      defaultMode: requestedMode ?? defaultModeFor(cli, provider?.defaultMode),
      defaultModel: requestedModel ?? provider?.defaultModel,
      defaultReasoning:
        requestedReasoning === undefined
          ? providerReasoning(provider)
          : (requestedReasoning ?? undefined),
    },
  };
};

const planMutationConflict = (message: string): PlanConflictError =>
  new PlanConflictError({
    message,
    latestRevision: 0,
    latest: null,
  });

/** `Plan.watch` handler, shared with the RPC integration test. */
export const planWatch = (sessionId: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (session === null || !session.worktreePath) return Stream.empty;
      const store = yield* PlanStore;
      return store.watch(
        session.worktreePath,
        session.id,
        session.activeChatId,
      );
    }),
  );

/** Internal ordered append used by dispatch/relay flows and their CAS tests. */
export const planAppendMessage = (input: {
  readonly sessionId: string;
  readonly planId: string;
  readonly baseRevision: number;
  readonly annotationId: string;
  readonly body: string;
  readonly authorKind: "user" | "agent";
  readonly authorId: string;
  readonly mentionedParticipantIds: ReadonlyArray<string>;
  readonly deliveryState: PlanCommentMessageDeliveryState;
}) =>
  SessionStore.get(input.sessionId).pipe(
    Effect.flatMap((session) =>
      session.worktreePath == null
        ? Effect.fail(
            planMutationConflict("This session has no plan worktree."),
          )
        : PlanStore.appendAnnotationMessage(session.worktreePath, input),
    ),
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(planMutationConflict("The plan session no longer exists.")),
    ),
  );

/** `Plan.updateMessageDelivery` handler. */
export const planUpdateMessageDelivery = (input: {
  readonly sessionId: string;
  readonly planId: string;
  readonly baseRevision: number;
  readonly annotationId: string;
  readonly messageId: string;
  readonly deliveryState: PlanCommentMessageDeliveryState;
  readonly author: "user" | "agent";
}) =>
  SessionStore.get(input.sessionId).pipe(
    Effect.flatMap((session) =>
      session.worktreePath == null
        ? Effect.fail(
            planMutationConflict("This session has no plan worktree."),
          )
        : PlanStore.updateAnnotationMessageDelivery(
            session.worktreePath,
            input,
          ),
    ),
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(planMutationConflict("The plan session no longer exists.")),
    ),
  );

const planUpdateMentionDeliveries = (input: {
  readonly sessionId: string;
  readonly planId: string;
  readonly baseRevision: number;
  readonly annotationId: string;
  readonly messageId: string;
  readonly deliveries: ReadonlyArray<PlanCommentMentionDelivery>;
  readonly deliveryState: PlanCommentMessageDeliveryState;
  readonly author: "user" | "agent";
}) =>
  SessionStore.get(input.sessionId).pipe(
    Effect.flatMap((session) =>
      session.worktreePath == null
        ? Effect.fail(
            planMutationConflict("This session has no plan worktree."),
          )
        : PlanStore.updateAnnotationMentionDeliveries(
            session.worktreePath,
            input,
          ),
    ),
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(planMutationConflict("The plan session no longer exists.")),
    ),
  );

/** `Plan.setThreadResolved` handler. */
export const planSetThreadResolved = (input: {
  readonly sessionId: string;
  readonly planId: string;
  readonly baseRevision: number;
  readonly annotationId: string;
  readonly resolved: boolean;
  readonly author: "user" | "agent";
}) =>
  SessionStore.get(input.sessionId).pipe(
    Effect.flatMap((session) =>
      session.worktreePath == null
        ? Effect.fail(
            planMutationConflict("This session has no plan worktree."),
          )
        : PlanStore.setAnnotationResolved(session.worktreePath, input),
    ),
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(planMutationConflict("The plan session no longer exists.")),
    ),
  );

interface PlanDispatchMessageInput {
  readonly sessionId: string;
  readonly planId: string;
  readonly baseRevision: number;
  readonly annotationId: string;
  readonly body: string;
  readonly authorId: string;
  readonly mentionedParticipantIds: ReadonlyArray<string>;
}

/**
 * Append a comment to the canonical plan. Plan comments now belong to the
 * selected workspace agent, so there is no participant fan-out or worker relay.
 */
export const planDispatchMessage = (input: PlanDispatchMessageInput) =>
  planAppendMessage({
    ...input,
    authorKind: "user",
    mentionedParticipantIds: [],
    deliveryState: "sent",
  }).pipe(
    Effect.flatMap((document) => {
      const messageId = document.plan.annotations
        .find((annotation) => annotation.id === input.annotationId)
        ?.messages.at(-1)?.id;
      if (messageId === undefined) {
        return Effect.fail(
          planMutationConflict("The recorded plan comment is no longer available."),
        );
      }
      return Effect.succeed({
        document,
        messageId,
        deliveries: [] as ReadonlyArray<PlanMentionDelivery>,
      });
    }),
  );

interface PlanDispatchExistingMessageInput {
  readonly sessionId: string;
  readonly planId: string;
  readonly baseRevision: number;
  readonly annotationId: string;
  readonly messageId: string;
}

/** Existing comments need no separate dispatch in the single-agent model. */
export const planDispatchExistingMessage = (
  input: PlanDispatchExistingMessageInput,
) =>
  SessionStore.get(input.sessionId).pipe(
    Effect.flatMap((session) =>
      session.worktreePath == null
        ? Effect.fail(planMutationConflict("This session has no plan worktree."))
        : PlanStore.readDocument(session.worktreePath),
    ),
    Effect.flatMap((document) =>
      document === null ||
      document.id !== input.planId ||
      document.revision !== input.baseRevision
        ? Effect.fail(
            planMutationConflict(
              "The canonical plan changed before the comment could be recorded.",
            ),
          )
        : (() => {
            const message = document.plan.annotations
              .find((annotation) => annotation.id === input.annotationId)
              ?.messages.find((candidate) => candidate.id === input.messageId);
            return message === undefined ||
              (message.deliveryState !== "pending" && message.deliveryState !== "failed")
              ? Effect.fail(
                  planMutationConflict(
                    `Retryable comment message "${input.messageId}" is no longer available.`,
                  ),
                )
              : Effect.succeed({
                  document,
                  messageId: message.id,
                  deliveries: [] as ReadonlyArray<PlanMentionDelivery>,
                });
          })(),
    ),
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(planMutationConflict("The plan session no longer exists.")),
    ),
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
    const route = sessionCreationDefaults(
      input.cli,
      config,
      input.model,
      input.mode,
      input.reasoning,
    );
    return yield* SessionStore.createFromPr(
      { ...input, cli: route.cli },
      {
        allowSharedCheckout,
        ...route.options,
      },
    );
  });

/**
 * `Sessions.create` handler. Seeds the new session's permission mode + model
 * from the chosen CLI's configured provider defaults (Settings · Providers), so
 * a session opens in the mode/model the user picked. Absent config → the store
 * omits them and the harness applies its own defaults. Exported for tests.
 */
export const createSession = (input: CreateSessionInput) =>
  Effect.gen(function* () {
    const resolvedInput = input.projectId === undefined
      ? input
      : yield* ProjectService.get(input.projectId).pipe(
          Effect.map((project) => ({
            ...input,
            repoPath: project.path,
            repoName: project.name,
            ...(project.environmentId === undefined
              ? {}
              : { environmentId: project.environmentId })
          }))
        );
    const config = yield* ConfigService.get().pipe(
      Effect.orElseSucceed(() => null),
    );
    const route = sessionCreationDefaults(
      resolvedInput.cli,
      config,
      resolvedInput.model,
      resolvedInput.mode,
      resolvedInput.reasoning,
    );
    return yield* SessionStore.create(
      { ...resolvedInput, cli: route.cli },
      route.options,
    );
  });

/** Provision on the selected device and mirror only the returned metadata locally. */
export const createSessionRouted = (input: CreateSessionInput) =>
  input.environmentId === undefined
    ? createSession(input)
    : Effect.gen(function* () {
        const resolvedInput = input.projectId === undefined
          ? input
          : yield* RemoteSessionService.requestOnEnvironment(
              input.environmentId!,
              "Projects.list",
              {}
            ).pipe(
              Effect.flatMap(Schema.decodeUnknown(Schema.Array(ProjectSchema))),
              Effect.flatMap((projects) => {
                const project = projects.find((candidate) => candidate.id === input.projectId)
                return project === undefined
                  ? Effect.fail(new GitError({ message: `Project not found: ${input.projectId}` }))
                  : Effect.succeed({ ...input, repoPath: project.path, repoName: project.name })
              }),
              Effect.mapError((cause) =>
                cause instanceof GitError
                  ? cause
                  : new GitError({ message: "Could not resolve the remote project", cause })
              )
            )
        return yield* provisionRemoteSession(
          input.environmentId!,
          "Sessions.create",
          resolvedInput
        )
      });

/**
 * Every model a harness offers — the WHOLE catalogue, deliberately uncurated.
 *
 * This feeds Settings' default-model picker, which is where a provider is
 * CONFIGURED. Curation (`visibleModels`) is defined as what shows in the
 * composer's model menu, so applying it here too would let it hide models from
 * the one surface you'd use to change it: curate down to three, and the fourth
 * can never be chosen as your default again — from inside the app there'd be no
 * way back. Configuration surfaces show what exists; `Models.catalog` is where
 * the operator's own choice is honoured.
 *
 * Discovery supplies the CLI's resolved binary path — a GUI-launched Electron
 * app has a threadbare PATH, so Codex's and opencode's own model lists are only
 * reachable via the absolute path discovery found. Exported for tests.
 */
export const modelsList = (cli: CliKind) =>
  Effect.gen(function* () {
    const clis = yield* DiscoveryService.list();
    return yield* ModelsService.list(
      cli,
      clis.find((c) => c.kind === cli)?.binPath,
    );
  });

/**
 * Every installed harness's models, each narrowed by its own curation — the
 * composer's model menu.
 *
 * This is the surface curation exists for: opencode's catalogue is resolved from
 * the user's own credentials, and a single OpenRouter key resolves ~342 models,
 * which is not a menu anyone can use. Applied HERE rather than inside
 * `ModelsService` so that service stays free of a config dependency (and
 * hermetically testable). Exported for tests.
 */
export const modelsCatalog = () =>
  Effect.gen(function* () {
    const clis = yield* DiscoveryService.list();
    const config = yield* ConfigService.get().pipe(
      Effect.orElseSucceed(() => null),
    );
    const catalog = yield* ModelsService.catalog(clis);
    return catalog.map((section) => ({
      ...section,
      models: filterVisible(
        section.models,
        config?.providers?.[section.cli]?.visibleModels,
      ),
    }));
  });

export const modelsCapabilities = () =>
  Effect.gen(function* () {
    const clis = yield* DiscoveryService.list();
    const config = yield* ConfigService.get().pipe(
      Effect.orElseSucceed(() => null),
    );
    const capabilities = yield* ModelsService.capabilities(clis);
    return capabilities.map((capability) => ({
      ...capability,
      models: filterVisible(
        capability.models,
        config?.providers?.[capability.cli]?.visibleModels,
      ),
    }));
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
    const route = sessionCreationDefaults(
      input.cli,
      config,
      input.model,
      input.mode,
      input.reasoning,
    );
    return yield* SessionStore.createFromIssue(
      { ...input, cli: route.cli },
      route.options,
    );
  });

const provisionRemoteSession = (
  environmentId: string,
  operation: "Sessions.create" | "Sessions.createFromPr" | "Sessions.createFromIssue",
  input: CreateSessionInput | CreateSessionFromPrInput | CreateSessionFromIssueInput,
) =>
  Effect.gen(function* () {
    const remote = yield* RemoteSessionService;
    const sessions = yield* SessionStore;
    const value = yield* remote.requestOnEnvironment(environmentId, operation, input).pipe(
      Effect.mapError((cause) => new GitError({ message: cause.message, cause })),
    );
    const created = yield* Schema.decodeUnknown(SessionSchema)(value).pipe(
      Effect.mapError((cause) => new GitError({
        message: "The remote device returned invalid session metadata",
        cause,
      })),
    );
    if (created.environmentId !== environmentId) {
      return yield* Effect.fail(new GitError({
        message: "The remote device returned a session for a different environment",
      }));
    }
    return yield* sessions.upsertRemote(created);
  });

export const createSessionFromPrRouted = (input: CreateSessionFromPrInput) =>
  input.environmentId === undefined
    ? createSessionFromPr(input)
    : provisionRemoteSession(input.environmentId, "Sessions.createFromPr", input);

export const createSessionFromIssueRouted = (input: CreateSessionFromIssueInput) =>
  input.environmentId === undefined
    ? createSessionFromIssue(input)
    : provisionRemoteSession(input.environmentId, "Sessions.createFromIssue", input);

export const setEnvironment = (
  sessionId: string,
  environmentId: string | undefined,
) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore;
    const environments = yield* EnvironmentService;
    const session = yield* sessions.get(sessionId);
    return yield* setSessionEnvironment(
      session,
      environmentId,
      {
        environments: () => environments.list,
        persist: (id, target) => sessions.setEnvironment(id, target),
        continueSession: (source, target) =>
          Effect.fail(new EnvironmentHandoffError({
            reason: "unavailable",
            message: "The target device did not admit a continuation workspace.",
            sessionId: source.id,
            ...(target === undefined ? {} : { environmentId: target }),
          })),
      },
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
  return candidates.find(
    (candidate) => candidate.name.toLocaleLowerCase() === name,
  ) ?? null;
};

const continuationRepositories = (
  environments: EnvironmentService,
  environmentId: string | undefined,
) => Effect.gen(function* () {
  if (environmentId === undefined) {
    const repositories = yield* WorkspaceService.listRepos();
    return repositories satisfies ReadonlyArray<ContinuationRepository>;
  }
  const result = yield* environments.discovery(environmentId);
  return (result.discovery?.repositories ?? []) satisfies ReadonlyArray<ContinuationRepository>;
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
    return yield* continueSessionOnEnvironment(
      session,
      environmentId,
      {
        environments: () => environments.list,
        persist: (id, target) => sessions.setEnvironment(id, target),
        continueSession: (source, target) => Effect.gen(function* () {
          const sourceRepositories = yield* continuationRepositories(
            environments,
            source.environmentId,
          ).pipe(Effect.orElseSucceed(() => []));
          const sourceRepository = sourceRepositories.find(
            (candidate) => candidate.path === source.repoPath,
          ) ?? sourceRepositories.find(
            (candidate) => candidate.name === source.repo,
          );
          const sourceIdentity = {
            name: sourceRepository?.name ?? source.repo,
            githubSlug: sourceRepository?.githubSlug ?? null,
          };
          const targetRepositories = yield* continuationRepositories(
            environments,
            target,
          ).pipe(
            Effect.mapError(() => new EnvironmentHandoffError({
              reason: "unavailable",
              message: "The target environment could not list its repositories.",
              sessionId: source.id,
              ...(target === undefined ? {} : { environmentId: target }),
            })),
          );
          const targetRepository = selectContinuationRepository(
            sourceIdentity,
            targetRepositories,
          );
          if (targetRepository === null) {
            return yield* Effect.fail(new EnvironmentHandoffError({
              reason: "unavailable",
              message: `${sourceIdentity.githubSlug ?? sourceIdentity.name} is not available on the target environment.`,
              sessionId: source.id,
              ...(target === undefined ? {} : { environmentId: target }),
            }));
          }
          const targetBaseBranch = source.baseBranch
            ?? targetRepository.defaultBranch
            ?? source.branch;
          if (target === undefined) {
            return yield* createSession({
              repoPath: targetRepository.path,
              repoName: targetRepository.name,
              cli: source.cli,
              baseBranch: targetBaseBranch,
              title: `${source.title} continuation`,
            }).pipe(
              Effect.mapError(() => new EnvironmentHandoffError({
                reason: "unavailable",
                message: "The desktop could not provision the continuation workspace.",
                sessionId: source.id,
              })),
            );
          }
          const value = yield* remote.requestOnEnvironment(
            target,
            "Sessions.continueOnEnvironment",
            {
              sourceSession: {
                ...source,
                title: `${source.title} continuation`,
                environmentId: target,
                repo: targetRepository.name,
                repoPath: targetRepository.path,
                worktreePath: undefined,
                baseBranch: targetBaseBranch,
              },
            },
          ).pipe(
            Effect.mapError(() => new EnvironmentHandoffError({
              reason: "unavailable",
              message: "The target device did not admit a continuation workspace.",
              sessionId: source.id,
              environmentId: target,
            })),
          );
          const created = yield* Schema.decodeUnknown(SessionSchema)(value).pipe(
            Effect.mapError(() => new EnvironmentHandoffError({
              reason: "unavailable",
              message: "The target device returned invalid continuation metadata.",
              sessionId: source.id,
              environmentId: target,
            })),
          );
          if (created.environmentId !== target) {
            return yield* Effect.fail(new EnvironmentHandoffError({
              reason: "unavailable",
              message: "The remote device returned a continuation for a different environment.",
              sessionId: source.id,
              environmentId: target,
            }));
          }
          return yield* sessions.upsertRemote(created).pipe(
            Effect.mapError(() => new EnvironmentHandoffError({
              reason: "unavailable",
              message: "The desktop could not persist the remote continuation.",
              sessionId: source.id,
              environmentId: target,
            })),
          );
        }),
      },
    );
  });

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
        identifier: input.issue.identifier,
        url: input.issue.url,
        title: input.issue.title,
        labels: input.issue.labels,
      },
      automations: input.automations,
    });
    return yield* SessionStore.get(input.sessionId);
  });

/** `Sessions.unlinkIssue` handler — detach the session's issue. */
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
    const issue = session ? issueReferenceOf(session) : undefined;
    const issueNumber = issue?.providerId === "github" ? Number(issue.id) : Number.NaN;
    if (!session?.worktreePath || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
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
    const issue = session ? issueReferenceOf(session) : undefined;
    const issueNumber = issue?.providerId === "github" ? Number(issue.id) : Number.NaN;
    if (!session?.worktreePath || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
    return yield* GitHubApi.issueView(
      session.worktreePath,
      issueNumber,
    );
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

/** `Asset.write` handler — revision-guarded replacement in the session worktree. */
export const assetWrite = (input: {
  sessionId: string;
  path: string;
  text: string;
  expectedRevision: string;
}) =>
  Effect.flatMap(assetWorktree(input.sessionId), (worktree) =>
    AssetService.write(
      worktree,
      input.path,
      input.text,
      input.expectedRevision,
    ),
  );

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

/** `Sessions.archive` handler — archive a session and return the updated record. */
export const archiveSession = (
  sessionId: string,
  reason: "merged" | "closed",
) =>
  Effect.gen(function* () {
    yield* SessionStore.archive(sessionId, reason);
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
  );

export const archiveSessionRouted = (
  sessionId: string,
  reason: "merged" | "closed",
) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId);
    const remote = yield* RemoteSessionService;
    return yield* routeSessionOperation(
      session,
      "Sessions.archive",
      { reason },
      { execute: () => archiveSession(sessionId, reason) },
      {
        execute: () => remote.request(session, "Sessions.archive", { reason }).pipe(
          Effect.flatMap(Schema.decodeUnknown(SessionSchema)),
          Effect.flatMap(SessionStore.upsertRemote),
          Effect.mapError((cause) =>
            new GitError({ message: "Could not archive the remote session", cause })),
        )
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
    yield* SessionStore.restore(sessionId);
    const session = yield* SessionStore.get(sessionId);
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
 * `Billing.paths` handler — what each installed harness is charged to.
 *
 * Reports every available harness, including ones with no metered key of their
 * own (opencode), so the pane can be read as a complete picture rather than a
 * list of exceptions.
 */
export const billingPaths = Effect.gen(function* () {
  // Re-probe rather than trust the memo. Signing in happens in a terminal and
  // does not restart the app, so a cached "not signed in" would outlive the fact
  // — on the one screen whose whole job is to report it accurately.
  resetSubscriptionCache();
  const clis = yield* DiscoveryService.list();
  return clis
    .filter((c) => c.available)
    .map((c) => {
      const subscription = hasSubscriptionAuth(c.kind);
      const keys = METERED_ENV_KEYS[c.kind] ?? [];
      return {
        cli: c.kind,
        path: billingPath(
          c.kind,
          process.env,
          subscription,
          subscriptionProbeFailed(c.kind),
        ),
        // A key WAS present and we withheld it — the case worth naming, because
        // it is the one that silently cost money before.
        keyWithheld:
          subscription && keys.some((k) => (process.env[k] ?? "").length > 0),
      };
    });
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

    const headSha = yield* GitHubApi.prHeadSha(
      session.worktreePath,
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

    const config = yield* ConfigService.get().pipe(
      Effect.orElseSucceed(() => null),
    );
    const cli = config?.github?.reviewCli ?? "claude";
    const model = reviewModelFor(cli, config?.github?.reviewModel);

    const diff = yield* GitHubApi.prDiff(
      session.worktreePath,
      session.prNumber,
    );

    const review = yield* ReviewService.run({
      sessionId,
      prNumber: session.prNumber,
      headSha,
      cwd: session.worktreePath,
      repo: session.repo,
      branch: session.branch,
      baseBranch: session.baseBranch ?? null,
      cli,
      model,
      diff,
    });

    // Post the minor/nit half to the PR as inline comments. The critical/major
    // half is NOT posted — it goes to the session's agent, which the renderer
    // does (it owns the conversation actor; this process has no way to reach it).
    //
    // Deliberately below the de-dupe: only a FRESH run posts. The short-circuit
    // above returns `prior` untouched, so a poll tick on an unchanged head can
    // never re-post the same nits.
    const posted = yield* postReviewToPr(
      session.worktreePath,
      session.prNumber,
      review,
      diff,
    );

    // Persist best-effort: a review the user can see now matters more than one
    // we can re-read later, and a failed write must not fail the run.
    yield* ReviewStore.set(sessionId, posted).pipe(Effect.ignore);
    return posted;
  });

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
    const n = yield* GitHubApi.prForWorktree(session.worktreePath);
    if (n !== null) {
      const repository = yield* GitHubApi.repository(session.worktreePath);
      yield* SessionStore.setGitHubLink(session.id, {
        installationId: repository.installationId,
        repositoryId: repository.id,
        prNumber: n,
      }).pipe(Effect.ignore);
    }
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
        await link(session.id, {
          installationId: resolved.installationId,
          repositoryId: resolved.id,
          prNumber: session.prNumber,
        });
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

export const awaitRelayAcknowledgement = (
  delivery: GitHubRelayDelivery,
  offer: (delivery: GitHubRelayDelivery) => void,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const key = relayAcknowledgementKey(delivery.clientId, delivery.cursor);
    pendingRelayAcknowledgements.set(key, { resolve, reject });
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
 * `Github.publish` is the sole mutation owner for publishing session work.
 * Installation credentials are captured only in this main-process scope and
 * cleared immediately after the authenticated push.
 */
export const githubPublish = (sessionId: string) =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox.make<PublishCheckpoint>();
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
            const session = await run(SessionStore.get(sessionId));
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
              readonly installationId: string;
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
                    if (session.semanticBranchPending === true) {
                      throw new Error(
                        "Finish creating the semantic task branch before publishing.",
                      );
                    }
                    if (!inspection.branch) {
                      throw new Error(
                        "The task worktree is detached. Finish semantic branch creation before publishing.",
                      );
                    }
                    if (inspection.branch !== session.branch) {
                      throw new Error(
                        `The worktree branch changed to ${inspection.branch}. Refresh the session before publishing.`,
                      );
                    }
                    if (
                      !isSessionPublishBranchReady(session, inspection.branch)
                    ) {
                      if (workspaceModeOf(session) === "direct") {
                        throw new Error(
                          "Publishing requires an isolated session worktree.",
                        );
                      }
                      throw new Error(
                        "The worktree is not on a validated semantic task branch.",
                      );
                    }
                    return inspection.branch;
                  },
                  generateMetadata: (inspection) =>
                    run(
                      claudePublishMetadataGenerator.generate({
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
                    pushCredential = await run(
                      GitHubAuth.credentialsForInstallation(
                        repository.installationId,
                        repository.fullName,
                        pushPermissions,
                      ),
                    );
                  },
                  push: async (branch) => {
                    const repository =
                      repositoryIdentity ??
                      (await run(GitHubApi.repository(cwd)));
                    if (!pushCredential) {
                      throw new Error(
                        "The short-lived GitHub push credential is unavailable. Retry publishing.",
                      );
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
                    const repository =
                      repositoryIdentity ??
                      (await run(GitHubApi.repository(cwd)));
                    return run(
                      GitHubAuth.createPullRequest({
                        installationId: repository.installationId,
                        repository: repository.fullName,
                        title: metadata.prTitle,
                        body: metadata.prBody,
                        head: `${repository.fullName.split("/")[0]}:${session.branch}`,
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
        { execute: () => Effect.succeed(Stream.unwrapScoped(
            Effect.gen(function* () {
              const mailbox = yield* Mailbox.make<PublishCheckpoint>();
              let latest: PublishCheckpoint | undefined = session.publish;
              const emit = (checkpoint: PublishCheckpoint) =>
                SessionStore.setPublishCheckpoint(session.id, checkpoint).pipe(
                  Effect.tap(() => Effect.sync(() => {
                    latest = checkpoint;
                    mailbox.unsafeOffer(checkpoint);
                  })),
                );

              const remoteResult = <A, I>(
                operation: string,
                payload: unknown,
                schema: Schema.Schema<A, I>,
              ) => remote.execute(session, operation, payload).pipe(
                Stream.runCollect,
                Effect.flatMap((events) => {
                  const terminal = Array.from(events).at(-1);
                  if (!terminal || terminal.kind === "failed") {
                    const message = terminal?.payload && typeof terminal.payload === "object" &&
                      "message" in terminal.payload && typeof terminal.payload.message === "string"
                      ? terminal.payload.message
                      : `Remote ${operation} failed.`;
                    return Effect.fail(new Error(message));
                  }
                  if (terminal.kind !== "complete") {
                    return Effect.fail(new Error(`Remote ${operation} did not complete.`));
                  }
                  return Schema.decodeUnknown(schema)(terminal.payload).pipe(
                    Effect.mapError(() => new Error(`Remote ${operation} returned an invalid result.`)),
                  );
                }),
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
                  const existing = prepared.existingPrNumber ?? (
                    yield* GitHubApi.prForBranchBySlug(prepared.githubSlug, prepared.branch)
                  );
                  const prStep = existing === null ? "creating-pr" : "updating-pr";
                  yield* emit({
                    step: prStep,
                    completed: [...throughCommit, "pushing", "resolving-pr"],
                    ...preparedFields,
                    updatedAt: new Date().toISOString(),
                  });
                  const prNumber = existing ?? (
                    yield* GitHubApi.prCreateBySlug(prepared.githubSlug, prepared.branch, {
                      title: prepared.prTitle,
                      body: prepared.prBody,
                      base: prepared.baseBranch,
                      draft: false,
                    })
                  );
                  if (existing !== null) {
                    yield* GitHubApi.prUpdateBySlug(prepared.githubSlug, existing, {
                      title: prepared.prTitle,
                      body: prepared.prBody,
                    });
                  }
                  yield* emit({
                    step: "linking",
                    completed: [...throughCommit, "pushing", "resolving-pr", prStep],
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
                      "message" in error && typeof error.message === "string"
                        ? error.message
                        : "Remote publishing failed.",
                      latest,
                    );
                    return SessionStore.setPublishCheckpoint(session.id, failure).pipe(
                      Effect.catchAll(() => Effect.void),
                      Effect.andThen(Effect.sync(() => mailbox.unsafeOffer(failure))),
                    );
                  }),
                  Effect.ensuring(mailbox.end),
                ),
              );
              return Mailbox.toStream(mailbox);
            }),
          )) },
      );
    }).pipe(
      Effect.catchAll((error) => Effect.succeed(Stream.make({
        step: "failed" as const,
        completed: [],
        error: "message" in error && typeof error.message === "string"
          ? error.message
          : "Publishing failed.",
        updatedAt: new Date().toISOString(),
      })))
    )
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
    const cwd =
      input.cwd ??
      (yield* resolveSession(input.sessionId))?.worktreePath ??
      undefined;
    const terminals = yield* TerminalService;
    return yield* terminals.create({
      sessionId: input.sessionId,
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
  cli: "claude" | "codex",
  reasoning: Parameters<typeof SessionStore.setReasoning>[2],
) =>
  SessionStore.setReasoning(sessionId, cli, reasoning).pipe(
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
  setting.type !== "secret" && settingValidationFailure(setting, value) === null;

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
    yield* pluginStorageSet(pluginId, pluginSettingStorageKey(settingId), value);
  });

const mapPluginSecretStoreError =
  (
    pluginId: string,
    reason: (cause: PluginSecretStoreUnavailable) => string,
  ) =>
  <A, R>(effect: Effect.Effect<A, PluginSecretStoreUnavailable, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new PluginError({ pluginId, reason: reason(cause), cause }),
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
    yield* pluginSecrets.set(pluginId, settingId, value).pipe(
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
    yield* pluginSecrets.clear(pluginId, settingId).pipe(
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
    yield* pluginSecrets.clearPlugin(pluginId).pipe(
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

/**
 * Handlers for every procedure in the group. Each one delegates straight to an
 * Effect service, so the group remains the sole contract. `Discovery.list`
 * pulls in a `CommandExecutor` requirement (via `DiscoveryService.list()`) that
 * `AppLayer` satisfies with the Node platform layer.
 */
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
          if (Option.isNone(childInfo) || childInfo.value.type !== "Directory") {
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

const CoreHandlersLayer = JinglerCoreRpcs.toLayer({
  "Billing.paths": () => billingPaths,
  "Discovery.list": () => DiscoveryService.list(),
  "Environment.list": () => EnvironmentService.list,
  "Environment.refresh": () => EnvironmentService.refresh,
  "Environment.discovery": ({ deviceId }) => EnvironmentService.discovery(deviceId),
  "Environment.watch": () =>
    Stream.repeatEffectWithSchedule(
      EnvironmentService.list.pipe(
        // Presence polling is long-lived. A token refresh or brief relay outage
        // pauses updates rather than permanently terminating the subscription.
        Effect.retry(Schedule.exponential("1 second")),
      ),
      Schedule.spaced("10 seconds"),
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
          const sessions = yield* SessionStore.list()
          const discovered = yield* WorkspaceService.listRepos().pipe(
            Effect.orElseSucceed(() => [])
          )
          const projects = yield* ProjectService.backfill([
            ...sessions.flatMap((session) =>
              session.environmentId !== undefined || session.repoPath === undefined
                ? []
                : [{ path: session.repoPath, name: session.repo }]
            ),
            ...discovered.map((repository) => ({
              path: repository.path,
              name: repository.name
            }))
          ])
          const byPath = new Map(projects.map((project) => [project.path, project.id]))
          yield* Effect.forEach(
            sessions.filter(
              (session) =>
                session.environmentId === undefined &&
                session.projectId === undefined &&
                session.repoPath !== undefined
            ),
            (session) => {
              const projectId = byPath.get(resolve(session.repoPath!))
              return projectId === undefined
                ? Effect.void
                : SessionStore.setProject(session.id, projectId).pipe(Effect.asVoid)
            },
            { concurrency: 1, discard: true }
          )
          return projects
        })
      : RemoteSessionService.requestOnEnvironment(environmentId, "Projects.list", {}).pipe(
          Effect.flatMap(Schema.decodeUnknown(Schema.Array(ProjectSchema))),
          Effect.map((projects) =>
            projects.map((project) => ({ ...project, environmentId }))
          ),
          Effect.mapError(
            (cause) => new GitError({ message: "Could not list projects on the selected device", cause })
          )
        ),
  "Projects.register": (input) =>
    input.environmentId === undefined
      ? ProjectService.register(input)
      : RemoteSessionService.requestOnEnvironment(
          input.environmentId,
          "Projects.register",
          { path: input.path, ...(input.name === undefined ? {} : { name: input.name }) }
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(ProjectSchema)),
          Effect.map((project) => ({ ...project, environmentId: input.environmentId })),
          Effect.mapError(
            (cause) => new GitError({ message: "Could not register the remote project", cause })
          )
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
      const directoryName = path.basename(repositoryName.trim().replace(/\.git$/i, ""));
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
          { path: input.path, ...(input.name === undefined ? {} : { name: input.name }) }
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(ProjectSchema)),
          Effect.map((project) => ({ ...project, environmentId: input.environmentId })),
          Effect.mapError(
            (cause) => new GitError({ message: "Could not create the remote project", cause })
          )
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
            ...(input.name === undefined ? {} : { name: input.name })
          }
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(ProjectSchema)),
          Effect.map((project) => ({ ...project, environmentId: input.environmentId })),
          Effect.mapError(
            (cause) => new GitError({ message: "Could not clone the remote project", cause })
          )
        ),
  "Projects.cloneFromGitHub": (input) =>
    Effect.gen(function* () {
      const credential = yield* GitHubAuth.credentialsForInstallation(
        input.installationId,
        input.repository,
        ["contents:read"],
      );
      yield* GitService.cloneWithInstallationToken(
        input.destination,
        input.repository,
        credential.token,
      );
      return yield* ProjectService.register({
        path: input.destination,
        ...(input.name === undefined ? {} : { name: input.name }),
      });
    }),
  "Projects.ensureOnEnvironment": ({ projectId, environmentId }) =>
    Effect.gen(function* () {
      const project = yield* ProjectService.get(projectId)
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
        { url, name: project.name }
      ).pipe(
        Effect.flatMap(Schema.decodeUnknown(ProjectSchema)),
        Effect.map((remoteProject) => ({ ...remoteProject, environmentId })),
        Effect.mapError((cause) =>
          cause instanceof GitError
            ? cause
            : new GitError({ message: `Could not prepare ${project.name} on the selected host`, cause })
        )
      )
    }),
  "Projects.remove": ({ id, environmentId }) =>
    environmentId === undefined
      ? ProjectService.remove(id)
      : RemoteSessionService.requestOnEnvironment(environmentId, "Projects.remove", { id }).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) => new GitError({ message: "Could not remove the remote project registration", cause })
          )
        ),
  "Workspace.repos": () => WorkspaceService.listRepos(),
  "Workspace.branches": ({ repoPath, environmentId }) =>
    environmentId
      ? RemoteSessionService.requestOnEnvironment(environmentId, "Workspace.branches", { repoPath }).pipe(
          Effect.flatMap(Schema.decodeUnknown(Schema.Array(Schema.String))),
          Effect.mapError((cause) => new GitError({ message: "Could not list remote branches", cause })),
        )
      : WorkspaceService.branches(repoPath),
  "Workspace.files": ({ repoPath, environmentId }) =>
    environmentId
      ? RemoteSessionService.requestOnEnvironment(environmentId, "Workspace.files", { repoPath }).pipe(
          Effect.flatMap(Schema.decodeUnknown(Schema.Array(Schema.String))),
          Effect.mapError((cause) => new GitError({ message: "Could not list remote files", cause })),
        )
      : WorkspaceService.files(repoPath),
  "Workspace.revertFile": (input) => workspaceRevertFile(input),
  "Workspace.revertLines": (input) => workspaceRevertLines(input),
  "Sessions.list": () => SessionStore.list(),
  "Sessions.get": ({ id }) => SessionStore.get(id),
  "Sessions.create": (input) => createSessionRouted(input),
  "Sessions.createFromPr": (input) => createSessionFromPrRouted(input),
  "Sessions.createFromIssue": (input) => createSessionFromIssueRouted(input),
  "Sessions.linkIssue": (input) => linkIssue(input),
  "Sessions.unlinkIssue": ({ sessionId }) => unlinkIssue(sessionId),
  "Sessions.clearInitialPrompt": ({ sessionId }) =>
    Effect.gen(function* () {
      yield* SessionStore.clearInitialPrompt(sessionId);
      return yield* SessionStore.get(sessionId);
    }),
  "Sessions.archive": ({ sessionId, reason }) =>
    archiveSessionRouted(sessionId, reason),
  "Sessions.restore": ({ sessionId }) => restoreSession(sessionId),
  "Sessions.retitle": ({ sessionId }) =>
    retitleSession(sessionId, claudeTitleGenerator),
  "Sessions.rename": ({ sessionId, title }) => renameSession(sessionId, title),
  "Sessions.setStatus": ({ sessionId, status }) =>
    setSessionStatus(sessionId, status),
  "Sessions.setPersistent": ({ sessionId, persistent }) =>
    setSessionPersistent(sessionId, persistent),
  "Sessions.setEnvironment": ({ sessionId, environmentId }) =>
    setEnvironment(sessionId, environmentId),
  "Sessions.continueOnEnvironment": ({ sessionId, environmentId }) =>
    continueOnEnvironment(sessionId, environmentId),
  "Sessions.delete": ({ sessionId }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (session?.environmentId) {
        const remote = yield* RemoteSessionService;
        yield* removeRemoteSessionMirror(
          remote.request(session, "Sessions.delete", {}),
          remote.forget(sessionId).pipe(
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
      const runner = yield* AgentRunner;
      const browserControl = yield* BrowserControlMcpService;
      const preview = yield* PreviewViewService;
      const chats = [
        ...(session?.chats ?? []),
        ...(session?.closedChats ?? []),
      ];
      for (const chat of chats) {
        // Deletion is stronger than an ordinary Stop click: do not remove the
        // transcript/state until the harness finalizers have actually finished.
        yield* runner.stop(sessionId, chat.id, true);
      }
      yield* browserControl.revoke(sessionId);
      yield* preview.deleteSession(sessionId);
      yield* BackgroundTaskStore.clear(sessionId);
      yield* SessionStore.remove(sessionId);
      if (relayRoute) {
        yield* GitHubAuth.unlinkSessionRoute(relayRoute.relaySessionId).pipe(
          Effect.ignore,
        );
      }
      for (const chat of chats) {
        yield* TranscriptStore.remove(chat.id);
        yield* ContextManager.forget(chat.id);
      }
      if (session?.worktreePath)
        yield* PlanStore.removeAll(session.worktreePath);
      yield* ReviewStore.clear(sessionId);
    }),
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
  "Sessions.closeChat": ({ sessionId, chatId }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId);
      if (!session.chats.some((chat) => chat.id === chatId)) return session;
      const runner = yield* AgentRunner;
      yield* runner.stop(sessionId, chatId);
      // Drop the closed chat's per-chat state so it can't leak or strand rows:
      // its background-task rows + stop handle (nothing else sweeps a chat that
      // never runs again), and the runner's per-chat maps (the lock in particular
      // grows one-per-chat for the life of the process).
      yield* BackgroundTaskStore.clearChat(sessionId, chatId);
      yield* runner.forgetChat(chatId);
      const updated = yield* SessionStore.closeChat(sessionId, chatId);
      yield* ContextManager.forget(chatId);
      if (session.worktreePath) {
        yield* PlanStore.rehomeArtifact(
          session.worktreePath,
          sessionId,
          chatId,
          updated.activeChatId,
        );
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
          execute: () => Effect.gen(function* () {
            if (!session.chats.some((chat) => chat.id === chatId)) {
              return { messages: [], hasMore: false };
            }
            if (chatId === `c_${session.id}_1`) {
              yield* TranscriptStore.adoptLegacy(sessionId, chatId);
            }
            const page = yield* TranscriptStore.listPage(chatId, { before, limit });
            return {
              messages: withoutAttachmentData(page.messages),
              hasMore: page.hasMore,
              ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
            };
          }),
        },
        {
          execute: () => remote.request(session, "Sessions.transcriptPage", {
              chatId,
              before,
              limit,
            }).pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Struct({
              messages: Schema.Array(MessageSchema),
              hasMore: Schema.Boolean,
              cursor: Schema.optional(Schema.String),
            }))),
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
          execute: () => remote.request(session, "Sessions.diff", {}).pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.String)),
          ),
        },
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof GitError
          ? cause
          : new GitError({ message: "Could not load the session diff", cause }),
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
            execute: () => Effect.succeed(runner.prompt(
              sessionId,
              chatId,
              text,
              images ?? [],
              reasoning,
              undefined,
              externalInstruction,
              displayText,
            )),
          },
          {
            execute: () => Effect.succeed(
              remote.execute(session, "Agent.run", {
                chatId,
                text,
                displayText,
                images,
                reasoning,
                externalInstruction
              }).pipe(
                Stream.filter((event) => event.kind !== "complete"),
                Stream.mapEffect((event) =>
                  event.kind === "failed"
                    ? Effect.succeed<StreamEvent>({
                        _tag: "Failed",
                        message:
                          event.payload && typeof event.payload === "object" &&
                          "message" in event.payload && typeof event.payload.message === "string"
                            ? event.payload.message
                            : "The remote operation failed."
                      })
                    : Schema.decodeUnknown(StreamEventSchema)(event.payload).pipe(
                        Effect.orElseSucceed((): StreamEvent => ({
                          _tag: "Failed",
                          message: "The remote device returned an invalid agent event."
                        }))
                      )
                ),
                Stream.catchAll((error) => Stream.make({
                  _tag: "Failed" as const,
                  message: error.message
                }))
              )
            ),
          }
        );
      }).pipe(
        Effect.catchAll((error) => Effect.succeed(Stream.make({
          _tag: "Failed" as const,
          message: "message" in error && typeof error.message === "string"
            ? error.message
            : "The session could not be started."
        })))
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
        { execute: () => runner.decideGate(sessionId, chatId, gateId, decision) },
        { execute: () => remote.request(session, "Agent.decideGate", { chatId, gateId, decision }).pipe(Effect.asVoid) },
      );
    }).pipe(Effect.mapError((cause) => new GitError({ message: "Could not submit the approval decision", cause }))),
  "Agent.answerQuestion": ({ sessionId, chatId, requestId, answers }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId);
      const runner = yield* AgentRunner;
      const remote = yield* RemoteSessionService;
      return yield* routeSessionOperation(
        session,
        "Agent.answerQuestion",
        { chatId, requestId, answers },
        { execute: () => runner.answerQuestion(sessionId, chatId, requestId, answers) },
        { execute: () => remote.request(session, "Agent.answerQuestion", { chatId, requestId, answers }).pipe(Effect.asVoid) },
      );
    }).pipe(Effect.mapError((cause) => new GitError({ message: "Could not submit the answer", cause }))),
  "Agent.setMode": ({ sessionId, chatId, mode }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.setMode(sessionId, chatId, mode),
    ),
  "Agent.setReasoning": ({ sessionId, cli, reasoning }) =>
    setReasoning(sessionId, cli, reasoning),
  "Agent.commentPlanStep": ({ sessionId, planId, stepId, body, anchor }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.commentPlanStep(sessionId, planId, stepId, body, anchor),
    ),
  "Agent.revisePlan": ({ sessionId, planId }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.revisePlan(sessionId, planId),
    ),
  "Agent.approvePlan": ({ sessionId, planId, executionMode, revision }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.approvePlan(sessionId, planId, executionMode, revision),
    ),
  "Agent.resumePlan": ({ sessionId, chatId, planId, revision }) =>
    Stream.unwrap(
      Effect.map(AgentRunner, (runner) =>
        runner.resumePlan(sessionId, chatId, planId, revision),
      ),
    ),
  "Agent.setHarness": ({ sessionId, chatId, cli, model }) =>
    SessionStore.setHarness(sessionId, chatId, cli, model).pipe(
      Effect.andThen(SessionStore.get(sessionId)),
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
        { execute: () => remote.request(session, "Agent.stop", { chatId }).pipe(Effect.asVoid) },
      );
    }).pipe(Effect.mapError((cause) => new GitError({ message: "Could not stop the agent", cause }))),
  // Not `AgentRunner.stop` scoped smaller: that halts the whole turn. A
  // sub-agent is killed through the run's own per-task handle, which is what
  // `BackgroundTaskStore` holds.
  "Agent.stopSubagent": ({ sessionId, chatId, agentId }) =>
    BackgroundTaskStore.stopHandled(sessionId, chatId, agentId),
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
          execute: () => remote.request(session, "Agent.steer", { chatId, text, images }).pipe(
            Effect.flatMap((value) => Schema.decodeUnknown(
              Schema.Union(
                Schema.Struct({ status: Schema.Literal("accepted"), user: MessageSchema, assistant: MessageSchema }),
                Schema.Struct({ status: Schema.Literal("deferred", "unsupported") })
              )
            )(value))
          ),
        },
      );
    }).pipe(Effect.mapError((cause) => new GitError({ message: "Could not steer the agent", cause }))),
  "Skills.list": ({ sessionId }) => skillsList(sessionId),
  "OpenConnector.get": () => openConnectorGet(),
  "OpenConnector.set": ({ config, token }) => openConnectorSet(config, token),
  "OpenConnector.test": () => openConnectorTest(),
  "OpenConnector.autoSetup": () => openConnectorAutoSetup(),
  "OpenConnector.injection": () => openConnectorInjection(),
  "Connector.providers": () => OpenConnectorApi.listProviders(),
  "Connector.provider": ({ service }) => OpenConnectorApi.getProvider(service),
  "Connector.connections": () => OpenConnectorApi.listConnections(),
  "Connector.oauthConfigs": () => OpenConnectorApi.oauthConfigs(),
  "Connector.connect": ({ service, authType, values, connectionName }) =>
    OpenConnectorApi.putConnection(
      service,
      authType,
      { ...values },
      connectionName,
    ),
  "Connector.disconnect": ({ service, connectionName }) =>
    OpenConnectorApi.deleteConnection(service, connectionName),
  "Connector.setOauthConfig": ({ provider, clientId, clientSecret, extra }) =>
    OpenConnectorApi.putOauthConfig(
      provider,
      clientId,
      clientSecret,
      extra ? { ...extra } : undefined,
    ),
  "Connector.startOauth": ({ service, connectionName }) =>
    connectorStartOauth(service, connectionName),
  // Discovery supplies the CLI's resolved binary path — a GUI-launched Electron
  // app has a threadbare PATH, so Codex's own model list is only reachable via
  // the absolute path discovery found.
  "Models.list": ({ cli }) => modelsList(cli),
  "Models.catalog": () => modelsCatalog(),
  "Models.capabilities": () => modelsCapabilities(),
  "Usage.get": () =>
    Effect.flatMap(DiscoveryService.list(), (clis) => UsageService.get(clis)),
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
  "Config.setMemory": (memory) => ConfigService.setMemory(memory),
  "Memory.request": memoryRpcRequest,
  "Memory.suggestions": ({ organizationId, pageId, limit }) =>
    memorySuggestions(organizationId, pageId, limit ?? 5),
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
  "Config.setPlanAutoRun": ({ planAutoRun }) =>
    ConfigService.setPlanAutoRun(planAutoRun),
  "Config.setAdhdMode": ({ adhdMode }) => ConfigService.setAdhdMode(adhdMode),
  "Config.setFontScale": ({ fontScale }) =>
    ConfigService.setFontScale(fontScale),
  "Config.setDefaultCli": ({ cli }) => ConfigService.setDefaultCli(cli),
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
  "Config.setProvider": ({ cli, provider }) =>
    ConfigService.setProvider(cli, provider),
  "Github.events": () => githubEvents(),
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
  "Github.ackEvent": ({ clientId, cursor }) => githubAckEvent(clientId, cursor),
});

const ReviewHandlersLayer = JinglerReviewRpcs.toLayer({
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
  "Plan.current": ({ sessionId }) =>
    SessionStore.get(sessionId).pipe(
      Effect.flatMap((session) =>
        session.worktreePath
          ? PlanStore.readDocument(
              session.worktreePath,
              session.id,
              session.activeChatId,
            )
          : Effect.succeed(null),
      ),
      Effect.orElseSucceed(() => null),
    ),
  "Plan.startDraft": ({ sessionId }) =>
    SessionStore.get(sessionId).pipe(
      // Collapse a missing session into the RPC's declared error union
      // (SessionNotFoundError is not part of it).
      Effect.catchAll(() =>
        Effect.fail(
          new PlanPersistenceError({
            message: "This session has no plan worktree.",
            cause: "no-session",
          }),
        ),
      ),
      Effect.flatMap((session) =>
        session.worktreePath
          ? PlanStore.startDraft(
              session.worktreePath,
              session.id,
              session.activeChatId,
            )
          : Effect.fail(
              new PlanPersistenceError({
                message: "This session has no plan worktree.",
                cause: "no-worktree",
              }),
            ),
      ),
    ),
  "Plan.watch": ({ sessionId }) => planWatch(sessionId),
  "Plan.updateDocument": ({ sessionId, planId, baseRevision, plan, author }) =>
    SessionStore.get(sessionId).pipe(
      Effect.map((session) => session.worktreePath),
      Effect.flatMap((worktreePath) =>
        worktreePath == null
          ? Effect.fail(
              new PlanConflictError({
                message: "This session has no plan worktree.",
                latestRevision: 0,
                latest: null,
              }),
            )
          : PlanStore.updateDocument(worktreePath, {
              planId,
              baseRevision,
              plan,
              author,
            }),
      ),
      Effect.catchTag("SessionNotFoundError", () =>
        Effect.fail(
          new PlanConflictError({
            message: "The plan session no longer exists.",
            latestRevision: 0,
            latest: null,
          }),
        ),
      ),
    ),
  "Plan.dispatchMessage": (input) => planDispatchMessage(input),
  "Plan.dispatchExistingMessage": (input) => planDispatchExistingMessage(input),
  "Plan.updateMessageDelivery": (input) => planUpdateMessageDelivery(input),
  "Plan.setThreadResolved": (input) => planSetThreadResolved(input),
  "Review.run": ({ sessionId, force }) => reviewRun(sessionId, force),
  // Unwrapped from the service like `Terminal.attach` — the reviewer outlives any
  // one watcher, so the stream attaches to it rather than starting it.
  "Review.watch": ({ sessionId, chatId }) =>
    Stream.unwrap(Effect.map(ReviewService, (r) => r.watch(sessionId, chatId))),
  "Review.get": ({ sessionId }) => reviewGet(sessionId),
  "Review.markRouted": ({ sessionId }) => reviewMarkRouted(sessionId),
  "Review.reconcile": ({ sessionId }) => reviewReconcile(sessionId),
  "Github.createPr": ({ sessionId }) => githubPublishRouted(sessionId),
  "Github.comment": (input) => githubComment(input),
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
    Stream.unwrap(Effect.map(TerminalService, (t) => t.attach(terminalId))),
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
  "BrowserPreview.open": ({ sessionId, url, bounds }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.openBrowser(sessionId, url, bounds),
    ),
  "BrowserPreview.setBounds": ({ sessionId, bounds }) =>
    Effect.flatMap(PreviewViewService, (b) => b.setBounds(sessionId, bounds)),
  "BrowserPreview.navigate": ({ sessionId, url }) =>
    Effect.flatMap(PreviewViewService, (b) => b.navigate(sessionId, url)),
  "BrowserPreview.reload": ({ sessionId }) =>
    Effect.flatMap(PreviewViewService, (b) => b.reload(sessionId)),
  "BrowserPreview.setVisible": ({ sessionId, visible }) =>
    Effect.flatMap(PreviewViewService, (b) => b.setVisible(sessionId, visible)),
  // Browser control — the SAME native view, driven by an agent (via the
  // browser-control MCP) so it can QA a preview URL where the operator watches.
  // Each op reveals the dock inside PreviewViewService.
  "BrowserControl.navigate": ({ sessionId, url }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.controlNavigate(sessionId, url),
    ),
  "BrowserControl.screenshot": ({ sessionId }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlScreenshot(sessionId)),
  "BrowserControl.click": ({ sessionId, selector }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.controlClick(sessionId, selector),
    ),
  "BrowserControl.type": ({ sessionId, selector, text }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.controlType(sessionId, selector, text),
    ),
  "BrowserControl.readText": ({ sessionId }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlReadText(sessionId)),
  "BrowserControl.evaluate": ({ sessionId, expression }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.controlEvaluate(sessionId, expression),
    ),
  "BrowserControl.waitForSelector": ({ sessionId, selector, timeoutMs }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.controlWaitForSelector(sessionId, selector, timeoutMs),
    ),

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
  "Auth.getSession": () => AuthService.getSession(),
  "Auth.startSignIn": ({ provider }) => AuthService.startSignIn(provider),
  "Auth.sendMagicLink": ({ email, name }) =>
    AuthService.sendMagicLink(email, name),
  "Auth.signOut": () => AuthService.signOut(),

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
    Stream.unwrap(Effect.map(ThemeService, (t) => t.watch())),

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
    Stream.unwrap(
      Effect.map(PluginRegistry, (p) =>
        // Every emission means the directory changed, so the resolution cache
        // used by plugin resolution is stale by definition.
        p.watch().pipe(Stream.tap(() => Effect.sync(invalidatePluginCatalog))),
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
  "Plugins.uninstall": ({ pluginId }) =>
    uninstallPlugin(pluginId),

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

  "Plugins.issueProviderCreate": ({
    providerId,
    repository,
    title,
    body,
  }) =>
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
        const gone = () => disconnects.unsafeOffer(contents.id);
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
      const sendServerFrame = (response: FromServerEncoded): void => {
        try {
          sender?.send(RPC_CHANNEL, response);
        } catch (error) {
          const frame = response as {
            readonly _tag?: string;
            readonly requestId?: unknown;
          };
          console.error(
            `[rpc] server frame failed to serialize (tag=${frame._tag ?? "?"} requestId=${String(frame.requestId ?? "?")}); retrying JSON-normalised`,
            error,
          );
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
          try {
            sender?.send(
              RPC_CHANNEL,
              JSON.parse(JSON.stringify(response)) as FromServerEncoded,
            );
          } catch (fallbackError) {
            console.error(
              "[rpc] server frame is unrecoverable; dropping it to keep the transport alive",
              fallbackError,
            );
          }
        }
      };

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
 * listener; it still requires `CommandExecutor | DiscoveryService | SessionStore
 * | ContextManager`, which `AppLayer` provides.
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
  | AgentRunner
  | AppPaths
  | AssetService
  | AuthService
  | BackgroundTaskStore
  | BrowserControlMcpService
  | CliAdapter
  | CommandExecutor.CommandExecutor
  | ConfigService
  | ContextManager
  | DialogService
  | DiscoveryService
  | EnvironmentService
  | FileSystem.FileSystem
  | GitHubApi
  | GitHubAuth
  | GitHubEventStore
  | GitService
  | MemoryService
  | ModelsService
  | OpenConnectorApi
  | OpenConnectorService
  | Path.Path
  | PlanStore
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
  | SkillsService
  | TerminalService
  | ThemeService
  | TranscriptStore
  | UsageService
  | WorkspaceService;
export const RpcServerLive: Layer.Layer<never, never, RpcServerRequirements> =
  RpcServerLayer;
