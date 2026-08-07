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
  buildOrchestrationGroups,
  CliAdapter,
  ConfigService,
  claudeTitleGenerator,
  DiscoveryService,
  fetchOpencodeProviders,
  filterVisible,
  GitHubApi,
  GitHubAuth,
  githubPushPermissions,
  GitHubEventStore,
  GitService,
  ModelsService,
  MemoryService,
  OpenConnectorService,
  OpenConnectorApi,
  OrchestrationPersistenceError,
  OrchestrationService,
  recoverOrchestrationCheckpoints,
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
  PluginHost,
  PluginAuth,
  planReviewPost,
  retitleSession,
  ReviewService,
  ReviewStore,
  SessionStore,
  ContextManager,
  setOpencodeAuth,
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
  activePlanParticipants,
  defaultModeFor,
  GitHubApiError,
  GitError,
  parsePlanThreadReply,
  PlanConflictError,
  PlanPersistenceError,
  type PlanValidationError,
  planThreadRelayPrompt,
  planStageSemanticFingerprint,
  resolveFindings,
  ReviewError,
  reviewModelFor,
  resolveOrchestratorPreference,
  PluginError,
  SessionNotFoundError,
  workspaceModeOf,
} from "@jingler/core";
import type {
  BrowserBounds,
  AdversarialReview,
  CliKind,
  OpenConnectorConfig,
  OpenConnectorDefaults,
  OrchestratorResolution,
  StreamEvent,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  IssueAutomations,
  IssueSummary,
  Message,
  PlanCommentMentionDelivery,
  PlanCommentMessageDeliveryState,
  PlanDocument,
  PlanMentionDelivery,
  PlanParticipant,
  PlanStageAssignment,
  PluginCatalog,
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
  WorkerActivityReset,
  WorkerState,
  WorkspaceConfig,
} from "@jingler/core";
import type {
  OrchestrationCheckpoint,
  OrchestrationExecutionReport,
  OrchestrationStageStatus,
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
  MemoryReviewResult as MemoryReviewResultSchema,
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

const MemoryBackendReviews = Schema.Struct({
  reviews: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      workflowId: Schema.String,
      sourceId: Schema.String,
      proposedBy: Schema.String,
      createdAt: Schema.String,
      status: Schema.Literal("open", "accepted", "rejected", "superseded"),
      changeKind: Schema.Literal("factual", "mechanical"),
      pages: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          pageId: Schema.String,
          baseRevisionId: Schema.String,
          markdown: Schema.String,
          summary: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});

const MemoryBackendReviewResult = Schema.Struct({
  status: Schema.Literal("accepted", "rejected", "conflict"),
  conflicts: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        pageId: Schema.String,
        expectedBaseRevisionId: Schema.String,
        currentHeadRevisionId: Schema.String,
      }),
    ),
    { default: () => [] },
  ),
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

const memoryReviews = (organizationId: string) =>
  memoryTool(organizationId, "memory_reviews", { limit: 100 }).pipe(
    Effect.flatMap((value) =>
      decodeMemory(
        MemoryBackendReviews,
        value,
        "Memory review response was invalid",
      ),
    ),
    Effect.map((response) =>
      response.reviews.map((review) => ({
        id: review.id,
        workflowId: review.workflowId,
        sourceId: review.sourceId,
        proposedBy: review.proposedBy,
        createdAt: review.createdAt,
        status: review.status,
        changeKind: review.changeKind,
        pages: review.pages.map((page) => ({
          proposalId: page.id,
          pageId: page.pageId,
          title: page.pageId,
          baseRevisionId: page.baseRevisionId,
          summary: page.summary ?? "Proposed memory update",
          markdown: page.markdown,
        })),
      })),
    ),
  );

const memoryReview = (
  organizationId: string,
  proposalId: string,
  action: "approve" | "reject",
) =>
  memoryTool(organizationId, "memory_review", { proposalId, action }).pipe(
    Effect.flatMap((value) =>
      decodeMemory(
        MemoryBackendReviewResult,
        value,
        "Memory review response was invalid",
      ),
    ),
    Effect.flatMap(({ status, conflicts }) =>
      decodeMemory(
        MemoryReviewResultSchema,
        { status, proposalId, conflicts },
        "Memory review result was invalid",
      ),
    ),
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
    | "reviews"
    | "review"
    | "export";
  readonly range?: string;
  readonly limit?: number;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly query?: string;
  readonly pageId?: string;
  readonly proposalId?: string;
  readonly action?: "approve" | "reject";
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
    case "reviews":
      return memoryReviews(organizationId);
    case "review":
      if (!input.proposalId || !input.action) {
        return Effect.fail(
          memoryUiFailure("Memory review request was incomplete"),
        );
      }
      return memoryReview(organizationId, input.proposalId, input.action);
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
 * unified working diff (empty when there's no worktree or the tree is clean, or
 * on any git failure — the Changes rail treats that as "no changes yet").
 * Exported for tests.
 */
export const sessionDiff = (id: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(id).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!session?.worktreePath) return "";
    return yield* WorkspaceService.diff(session.worktreePath).pipe(
      Effect.orElseSucceed(() => ""),
    );
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

/** Resolve the provider-neutral planner route from the host's live catalogue. */
export const newSessionOrchestrator = (config: WorkspaceConfig | null) =>
  Effect.gen(function* () {
    const clis = yield* DiscoveryService.list();
    const catalog = yield* ModelsService.catalog(clis);
    return resolveOrchestratorPreference(config, catalog);
  }).pipe(Effect.catchAllCause(() => Effect.succeed(null)));

/** Shared route/default policy for blank, PR, and issue session creation. */
export const sessionCreationDefaults = (
  requestedCli: CliKind,
  config: WorkspaceConfig | null,
  orchestrator: OrchestratorResolution | null,
) => {
  const cli = orchestrator?.preference.cli ?? requestedCli;
  const provider = config?.providers?.[cli];
  return {
    cli,
    options: {
      chatRole:
        orchestrator === null ? ("direct" as const) : ("orchestrator" as const),
      // Jingler decides per turn whether bounded work is executed directly or
      // delegated behind the plan gate. Persisting the chat itself in read-only
      // plan mode made the direct branch pause on its first edit, so fresh
      // orchestrators start with their full tool authority.
      defaultMode: orchestrator
        ? ("auto" as const)
        : defaultModeFor(cli, provider?.defaultMode),
      defaultModel: orchestrator?.preference.model ?? provider?.defaultModel,
      defaultReasoning: providerReasoning(provider),
    },
  };
};

const persistedStageStatus = (
  status: OrchestrationStageStatus,
):
  | "queued"
  | "running"
  | "blocked"
  | "failed"
  | "interrupted"
  | "completed"
  | null => (status === "skipped" ? null : status);

/** The canonical producing chat owns execution strategy, never the selected tab. */
export const planUsesOrchestration = (
  session: Session,
  document: PlanDocument,
): boolean =>
  session.chats.find((chat) => chat.id === document.producingChatId)?.role ===
  "orchestrator";

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

/** Provider-neutral, de-duplicated snapshot for the plan mention picker. */
export const planParticipants = (sessionId: string, planId: string) =>
  Effect.gen(function* () {
    const runner = yield* AgentRunner;
    const orchestration = yield* OrchestrationService;
    const [mainParticipants, workerParticipants] = yield* Effect.all([
      runner.planParticipants(sessionId, planId),
      orchestration.planParticipants(sessionId, planId),
    ]);
    return activePlanParticipants([mainParticipants, workerParticipants]);
  });

const routePlanParticipant = (
  target: PlanParticipant,
  input: {
    readonly sessionId: string;
    readonly planId: string;
    readonly text: string;
  },
) =>
  Effect.gen(function* () {
    const ownedByWorker =
      target.role === "worker" ||
      target.ownerRoutingId?.startsWith("worker:") === true;
    return ownedByWorker
      ? yield* OrchestrationService.steerPlanParticipant({
          ...input,
          routingId: target.routingId,
        })
      : yield* Effect.flatMap(AgentRunner, (runner) =>
          runner.steerPlanParticipant({
            ...input,
            routingId: target.routingId,
          }),
        );
  });

interface PlanDispatchRouting<R> {
  readonly participants: (
    sessionId: string,
    planId: string,
  ) => Effect.Effect<ReadonlyArray<PlanParticipant>, never, R>;
  readonly route: (
    target: PlanParticipant,
    input: {
      readonly sessionId: string;
      readonly planId: string;
      readonly text: string;
    },
  ) => Effect.Effect<
    | { readonly status: "delivered"; readonly reply: string | null }
    | { readonly status: "unavailable" | "failed"; readonly detail: string },
    never,
    R
  >;
}

type LivePlanDispatchRequirements =
  | AgentRunner
  | AppPaths
  | FileSystem.FileSystem
  | OrchestrationService
  | Path.Path
  | PlanStore
  | SessionStore;

type PlanMutationRequirements =
  AppPaths | FileSystem.FileSystem | Path.Path | PlanStore | SessionStore;

const livePlanDispatchRouting: PlanDispatchRouting<LivePlanDispatchRequirements> =
  {
    participants: planParticipants,
    route: routePlanParticipant,
  };

interface PlanDispatchMessageInput {
  readonly sessionId: string;
  readonly planId: string;
  readonly baseRevision: number;
  readonly annotationId: string;
  readonly body: string;
  readonly authorId: string;
  readonly mentionedParticipantIds: ReadonlyArray<string>;
}

const PLAN_RELAY_DEPTH_LIMIT = 8;
const PLAN_RELAY_DELIVERY_BUDGET = 32;

const aggregateMessageDeliveryState = (
  deliveries: ReadonlyArray<PlanCommentMentionDelivery>,
): PlanCommentMessageDeliveryState => {
  if (
    deliveries.length === 0 ||
    deliveries.every((item) => item.status === "delivered")
  ) {
    return "sent";
  }
  return deliveries.some(
    (item) => item.status === "failed" || item.status === "unavailable",
  )
    ? "failed"
    : "pending";
};

const initialMentionDeliveries = (
  messageId: string,
  participantIds: ReadonlyArray<string>,
): ReadonlyArray<PlanCommentMentionDelivery> =>
  [...new Set(participantIds)].map((participantId) => ({
    participantId,
    status: "pending",
    dispatchId: `${messageId}:${participantId}`,
    detail: null,
    retryable: false,
  }));

/**
 * Durable outbox routing. Each target is claimed before its external side
 * effect, and every post-route mutation rebases on a newer canonical revision
 * instead of asking the caller to repeat an already accepted instruction.
 */
const routePlanMessageWithRouting = <R>(
  input: PlanDispatchMessageInput,
  routing: PlanDispatchRouting<R>,
  initial?: {
    readonly document: PlanDocument;
    readonly messageId: string;
  },
) =>
  Effect.gen(function* () {
    let document: PlanDocument;
    if (initial === undefined) {
      document = yield* planAppendMessage({
        ...input,
        authorKind: "user",
        mentionedParticipantIds: [...new Set(input.mentionedParticipantIds)],
        deliveryState:
          input.mentionedParticipantIds.length > 0 ? "pending" : "sent",
      });
    } else {
      document = initial.document;
    }
    const lastMessageId = (): string | null =>
      document.plan.annotations
        .find((annotation) => annotation.id === input.annotationId)
        ?.messages.at(-1)?.id ?? null;
    const initialMessageId = initial?.messageId ?? lastMessageId();
    if (initialMessageId === null) {
      return yield* Effect.fail(
        planMutationConflict(
          `Annotation "${input.annotationId}" did not retain its appended message.`,
        ),
      );
    }

    const rebaseMutation = (
      mutate: (
        baseRevision: number,
      ) => Effect.Effect<
        PlanDocument,
        PlanConflictError | PlanValidationError | PlanPersistenceError,
        PlanMutationRequirements
      >,
    ) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const result = yield* Effect.either(mutate(document.revision));
          if (result._tag === "Right") {
            document = result.right;
            return result.right;
          }
          if (
            result.left?._tag !== "PlanConflictError" ||
            result.left.latest === null
          ) {
            return yield* Effect.fail(result.left);
          }
          document = result.left.latest;
        }
        return yield* Effect.fail(
          planMutationConflict(
            "The plan kept changing while recording comment delivery.",
          ),
        );
      });

    const appendAgentMessage = (
      body: string,
      authorId: string,
      mentionedParticipantIds: ReadonlyArray<string>,
      deliveryState: PlanCommentMessageDeliveryState,
    ) =>
      Effect.gen(function* () {
        document = yield* rebaseMutation((baseRevision) =>
          planAppendMessage({
            sessionId: input.sessionId,
            planId: input.planId,
            baseRevision,
            annotationId: input.annotationId,
            body,
            authorKind: "agent",
            authorId,
            mentionedParticipantIds,
            deliveryState,
          }),
        );
        const messageId = lastMessageId();
        if (messageId === null) {
          return yield* Effect.fail(
            planMutationConflict(
              `Annotation "${input.annotationId}" did not retain its agent reply.`,
            ),
          );
        }
        return messageId;
      });

    const persistDeliveries = (
      messageId: string,
      deliveriesForMessage: ReadonlyArray<PlanCommentMentionDelivery>,
    ) =>
      rebaseMutation((baseRevision) =>
        planUpdateMentionDeliveries({
          sessionId: input.sessionId,
          planId: input.planId,
          baseRevision,
          annotationId: input.annotationId,
          messageId,
          deliveries: deliveriesForMessage,
          deliveryState: aggregateMessageDeliveryState(deliveriesForMessage),
          author: "agent",
        }),
      );

    const deliveries: Array<PlanMentionDelivery> = [];
    const queue: Array<{
      readonly messageId: string;
      readonly body: string;
      readonly mentionedParticipantIds: ReadonlyArray<string>;
      readonly depth: number;
      readonly sourceParticipantId: string;
      deliveries: Array<PlanCommentMentionDelivery>;
    }> = [
      {
        messageId: initialMessageId,
        body: input.body,
        mentionedParticipantIds: [...new Set(input.mentionedParticipantIds)],
        depth: 0,
        sourceParticipantId: `user:${input.authorId}`,
        deliveries: [],
      },
    ];

    let queueIndex = 0;
    let deliveryCount = 0;
    const visitedEdges = new Set<string>();
    while (queueIndex < queue.length) {
      const current = queue[queueIndex++]!;
      const persistedMessage = document.plan.annotations
        .find((annotation) => annotation.id === input.annotationId)
        ?.messages.find((message) => message.id === current.messageId);
      current.deliveries = persistedMessage?.mentionDeliveries
        ? [...persistedMessage.mentionDeliveries]
        : [
            ...initialMentionDeliveries(
              current.messageId,
              current.mentionedParticipantIds,
            ),
          ];
      if (persistedMessage?.mentionDeliveries === undefined) {
        yield* persistDeliveries(current.messageId, current.deliveries);
      }

      for (const delivery of current.deliveries) {
        const participantId = delivery.participantId;
        if (
          delivery.status === "delivered" ||
          delivery.status === "dispatching" ||
          (delivery.status === "unavailable" && !delivery.retryable)
        ) {
          continue;
        }
        const edge = `${current.sourceParticipantId}->${participantId}`;
        if (
          current.depth >= PLAN_RELAY_DEPTH_LIMIT ||
          deliveryCount >= PLAN_RELAY_DELIVERY_BUDGET ||
          visitedEdges.has(edge)
        ) {
          const detail =
            "The agent-to-agent relay safety limit was reached. Retry or reroute this message manually.";
          Object.assign(delivery, {
            status: "failed" as const,
            detail,
            retryable: true,
          });
          deliveries.push({
            participantId,
            status: "failed",
            detail,
            retryable: true,
          });
          yield* appendAgentMessage(
            `Could not continue to ${participantId}: ${detail}`,
            "jingler:dispatcher",
            [],
            "sent",
          );
          yield* persistDeliveries(current.messageId, current.deliveries);
          continue;
        }

        visitedEdges.add(edge);
        deliveryCount += 1;

        Object.assign(delivery, {
          status: "dispatching" as const,
          detail: null,
          retryable: false,
        });
        yield* persistDeliveries(current.messageId, current.deliveries);

        const available = yield* routing.participants(
          input.sessionId,
          input.planId,
        );
        const target = available.find(
          (participant) => participant.routingId === participantId,
        );
        if (target === undefined) {
          const detail =
            `Participant "${participantId}" became unavailable before delivery. ` +
            "Refresh the participant list, then retry or reroute this message.";
          Object.assign(delivery, {
            status: "unavailable" as const,
            detail,
            retryable: false,
          });
          deliveries.push({
            participantId,
            status: "unavailable",
            detail,
            retryable: false,
          });
          yield* appendAgentMessage(detail, "jingler:dispatcher", [], "sent");
          yield* persistDeliveries(current.messageId, current.deliveries);
          continue;
        }

        const routed = yield* routing.route(target, {
          sessionId: input.sessionId,
          planId: input.planId,
          text:
            `Dispatch ID: ${delivery.dispatchId}. Do not process this dispatch twice.\n\n` +
            planThreadRelayPrompt({
              annotationId: input.annotationId,
              target,
              body: current.body,
              availableParticipants: available,
            }),
        });
        if (routed.status !== "delivered") {
          Object.assign(delivery, {
            status: routed.status,
            detail: routed.detail,
            retryable: true,
          });
          deliveries.push({
            participantId,
            status: routed.status,
            detail: routed.detail,
            retryable: true,
          });
          yield* appendAgentMessage(
            routed.detail,
            "jingler:dispatcher",
            [],
            "sent",
          );
          yield* persistDeliveries(current.messageId, current.deliveries);
          continue;
        }

        Object.assign(delivery, {
          status: "delivered" as const,
          detail: null,
          retryable: false,
        });
        deliveries.push({
          participantId,
          status: "delivered",
          detail: null,
          retryable: false,
        });
        if (routed.reply !== null) {
          const reply = parsePlanThreadReply(routed.reply);
          const replyMessageId = yield* appendAgentMessage(
            reply.body,
            target.routingId,
            reply.mentionedParticipantIds,
            reply.mentionedParticipantIds.length > 0 ? "pending" : "sent",
          );
          if (reply.mentionedParticipantIds.length > 0) {
            queue.push({
              messageId: replyMessageId,
              body: reply.body,
              mentionedParticipantIds: reply.mentionedParticipantIds,
              depth: current.depth + 1,
              sourceParticipantId: target.routingId,
              deliveries: [],
            });
          }
        }
        yield* persistDeliveries(current.messageId, current.deliveries);
      }
    }

    return {
      document,
      messageId: initialMessageId,
      deliveries,
    };
  });

export const planDispatchMessageWithRouting = <R>(
  input: PlanDispatchMessageInput,
  routing: PlanDispatchRouting<R>,
) => routePlanMessageWithRouting(input, routing);

export const planDispatchMessage = (input: PlanDispatchMessageInput) =>
  planDispatchMessageWithRouting(input, livePlanDispatchRouting);

interface PlanDispatchExistingMessageInput {
  readonly sessionId: string;
  readonly planId: string;
  readonly baseRevision: number;
  readonly annotationId: string;
  readonly messageId: string;
}

/** Route a pending message created by the in-document selection composer. */
export const planDispatchExistingMessageWithRouting = <R>(
  input: PlanDispatchExistingMessageInput,
  routing: PlanDispatchRouting<R>,
) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(input.sessionId).pipe(
      Effect.catchAll(() =>
        Effect.fail(planMutationConflict("The plan session no longer exists.")),
      ),
    );
    if (session.worktreePath == null) {
      return yield* Effect.fail(
        planMutationConflict("This session has no plan worktree."),
      );
    }
    const store = yield* PlanStore;
    const document = yield* store.readDocument(
      session.worktreePath,
      session.id,
      session.activeChatId,
    );
    if (
      document === null ||
      document.id !== input.planId ||
      document.revision !== input.baseRevision
    ) {
      return yield* Effect.fail(
        planMutationConflict(
          "The canonical plan changed before the comment could be delivered.",
        ),
      );
    }
    const message = document.plan.annotations
      .find((annotation) => annotation.id === input.annotationId)
      ?.messages.find((candidate) => candidate.id === input.messageId);
    if (
      message === undefined ||
      (message.deliveryState !== "pending" &&
        message.deliveryState !== "failed")
    ) {
      return yield* Effect.fail(
        planMutationConflict(
          `Retryable comment message "${input.messageId}" is no longer available.`,
        ),
      );
    }
    if (
      message.mentionDeliveries !== undefined &&
      !message.mentionDeliveries.some(
        (delivery) =>
          delivery.status === "pending" ||
          (delivery.status === "failed" && delivery.retryable),
      )
    ) {
      return yield* Effect.fail(
        planMutationConflict(
          `Comment message "${input.messageId}" has no retryable targets. Mention a current participant in a new reply to reroute it.`,
        ),
      );
    }
    return yield* routePlanMessageWithRouting(
      {
        sessionId: input.sessionId,
        planId: input.planId,
        baseRevision: input.baseRevision,
        annotationId: input.annotationId,
        body: message.body,
        authorId: message.authorId,
        mentionedParticipantIds: message.mentionedParticipantIds,
      },
      routing,
      { document, messageId: message.id },
    );
  });

export const planDispatchExistingMessage = (
  input: PlanDispatchExistingMessageInput,
) => planDispatchExistingMessageWithRouting(input, livePlanDispatchRouting);

export const mergeCanonicalOrchestrationCheckpoints = (
  document: PlanDocument,
  checkpoints: ReadonlyArray<OrchestrationCheckpoint>,
): ReadonlyArray<OrchestrationCheckpoint> => {
  const checkpointByAgent = new Map(
    checkpoints.map((checkpoint) => [checkpoint.agentId, checkpoint]),
  );
  for (const stage of document.plan.stages) {
    const agentId = stage.assignment?.agentId;
    if (agentId === undefined) continue;
    const prior = checkpointByAgent.get(agentId);
    const completedStageIds = document.plan.stages
      .filter(
        (candidate) =>
          candidate.assignment?.agentId === agentId &&
          candidate.executionStatus === "completed",
      )
      .map((candidate) => candidate.id);
    checkpointByAgent.set(agentId, {
      agentId,
      state:
        prior?.state ?? (completedStageIds.length > 0 ? "completed" : "queued"),
      completedStageIds,
      resumeId: prior?.resumeId ?? null,
      message: prior?.message ?? null,
      attempt: prior?.attempt ?? 0,
    });
  }
  return [...checkpointByAgent.values()];
};

/**
 * Rebuild the durable worker rail after the main process restarts.
 *
 * Checkpoints intentionally restore lifecycle and routing only. Full worker
 * transcripts remain process-local by design; retry resumes the harness from
 * its durable resume id and starts a fresh attempt transcript.
 */
export const restoredOrchestrationSnapshot = (
  sessionId: string,
  document: PlanDocument,
  checkpoints: ReadonlyArray<OrchestrationCheckpoint>,
): WorkerActivityReset | null => {
  if (checkpoints.length === 0) return null;
  const graph = buildOrchestrationGroups(document.plan.stages);
  if (!graph.valid) return null;
  const recovered = new Map(
    recoverOrchestrationCheckpoints(
      mergeCanonicalOrchestrationCheckpoints(document, checkpoints),
    ).map((checkpoint) => [checkpoint.agentId, checkpoint]),
  );
  const workers = graph.groups.flatMap((group): ReadonlyArray<WorkerState> => {
    const checkpoint = recovered.get(group.agentId);
    if (checkpoint === undefined) return [];
    return [
      {
        worker: {
          sessionId,
          planId: document.id,
          producingChatId: document.producingChatId,
          agentId: group.agentId,
          stageIds: group.stages.map((stage) => stage.id),
          harness: group.assignment.cli,
          model: group.assignment.model,
          ...(group.assignment.reasoning === undefined
            ? {}
            : { reasoning: group.assignment.reasoning }),
          attempt: checkpoint.attempt,
        },
        status: checkpoint.state,
        message: checkpoint.message,
      },
    ];
  });
  if (workers.length === 0) return null;
  return {
    _tag: "Reset",
    sessionId,
    planId: document.id,
    producingChatId: document.producingChatId,
    mode: "replace",
    workers,
  };
};

/**
 * Apply a compiled assignment's complete execution route to a worker launch.
 * An absent reasoning setting deliberately omits both fields so the harness
 * retains its provider/model default.
 */
export const workerSessionSpecForAssignment = (
  assignment: PlanStageAssignment,
  base: Omit<
    SessionSpec,
    "cli" | "model" | "thinkingEnabled" | "reasoningEffort"
  >,
): SessionSpec => ({
  ...base,
  cli: assignment.cli,
  model: assignment.model,
  ...(assignment.reasoning === undefined
    ? {}
    : {
        thinkingEnabled: assignment.reasoning.enabled,
        ...(assignment.reasoning.effort === undefined
          ? {}
          : { reasoningEffort: assignment.reasoning.effort }),
      }),
});

export const orchestrationStagesCompleted = (
  document: PlanDocument | null,
): boolean =>
  document !== null &&
  document.plan.stages.every((stage) => stage.executionStatus === "completed");

const queuedOrchestrationFingerprints = (
  document: PlanDocument,
): ReadonlySet<string> =>
  new Set(
    document.plan.stages.flatMap((stage) =>
      stage.assignment !== null &&
      stage.assignment !== undefined &&
      stage.executionStatus === "queued"
        ? [`${stage.id}\u0000${planStageSemanticFingerprint(stage)}`]
        : [],
    ),
  );

const canonicalPlanForSession = (session: Session, planId: string) =>
  session.worktreePath === null || session.worktreePath === undefined
    ? Effect.succeed(null)
    : PlanStore.readDocument(
        session.worktreePath,
        session.id,
        session.activeChatId,
      ).pipe(
        Effect.map((document) => (document?.id === planId ? document : null)),
      );

const orchestrationPersistenceError = (
  error: PlanPersistenceError | { readonly message: string },
): OrchestrationPersistenceError =>
  new OrchestrationPersistenceError({
    message: error.message,
    cause: error,
  });

const recordOrchestrationFailure = (
  sessionId: string,
  planId: string,
  message: string,
) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (session?.worktreePath == null) return;
    const worktreePath = session.worktreePath;
    const document = yield* PlanStore.readDocument(
      worktreePath,
      session.id,
      session.activeChatId,
    );
    if (document === null || document.id !== planId) return;
    const stage = document.plan.stages.find(
      (candidate) => candidate.executionStatus !== "completed",
    );
    if (stage?.assignment !== null && stage?.assignment !== undefined) {
      yield* PlanStore.setStageExecutionStatus(worktreePath, {
        planId,
        stageId: stage.id,
        agentId: stage.assignment.agentId,
        status: "failed",
        message: `Orchestration failed: ${message}`,
        expectedStageFingerprint: planStageSemanticFingerprint(stage),
      });
    }
    yield* PlanStore.settleOrchestration(worktreePath, {
      planId,
      workersCompleted: false,
    });
  });

/**
 * Execute the latest approved canonical revision through provider-neutral
 * workers. Every callback is rebased by PlanStore onto the latest source, so
 * concurrent planner amendments and worker evidence cannot erase one another.
 */
export const executeOrchestration = (
  sessionId: string,
  planId: string,
  agentIds?: ReadonlyArray<string>,
): Effect.Effect<
  OrchestrationExecutionReport | null,
  never,
  | OrchestrationService
  | SessionStore
  | DiscoveryService
  | PlanStore
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  | AppPaths
> =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (session?.worktreePath == null) return null;
    const worktreePath = session.worktreePath;
    const clis = yield* DiscoveryService.list().pipe(
      Effect.orElseSucceed(() => []),
    );
    const binByCli = new Map(clis.map((cli) => [cli.kind, cli.binPath]));
    const service = yield* OrchestrationService;
    const store = yield* PlanStore;
    const persistence = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | AppPaths
    >();
    let latestReport: OrchestrationExecutionReport | null = null;
    while (true) {
      const document = yield* store
        .readDocument(worktreePath, session.id, session.activeChatId)
        .pipe(Effect.provide(persistence));
      if (document === null || document.id !== planId) return latestReport;
      const queuedBefore = queuedOrchestrationFingerprints(document);
      const checkpoints = yield* store
        .readOrchestrationCheckpoints(worktreePath, planId)
        .pipe(Effect.provide(persistence));
      const currentCheckpoints = mergeCanonicalOrchestrationCheckpoints(
        document,
        checkpoints,
      );

      const report = yield* service
        .execute({
          sessionId,
          planId,
          producingChatId: document.producingChatId,
          planRevision: document.revision,
          stages: document.plan.stages,
          checkpoints: currentCheckpoints,
          maxConcurrency: 4,
          ...(agentIds === undefined ? {} : { agentIds }),
          makeSessionSpec: ({ group, prompt, resumeId }) =>
            workerSessionSpecForAssignment(group.assignment, {
              repo: session.repo,
              branch: session.branch,
              cwd: worktreePath,
              prompt,
              images: [],
              binPath: binByCli.get(group.assignment.cli) ?? null,
              mode: "auto",
              resumeId,
            }),
          refreshStage: (_agentId, stageId) =>
            store
              .readDocument(worktreePath, session.id, session.activeChatId)
              .pipe(
                Effect.provide(persistence),
                Effect.map(
                  (latest) =>
                    latest?.plan.stages.find((stage) => stage.id === stageId) ??
                    null,
                ),
              ),
          callbacks: {
            onTaskState: (update) =>
              store
                .setTaskStatusLatest(worktreePath, {
                  planId,
                  stageId: update.stageId,
                  taskId: update.taskId,
                  status: update.status,
                  expectedStageFingerprint: update.stageFingerprint,
                })
                .pipe(
                  Effect.provide(persistence),
                  Effect.mapError(orchestrationPersistenceError),
                  Effect.asVoid,
                ),
            onStageState: (update) => {
              const status = persistedStageStatus(update.status);
              return status === null
                ? Effect.void
                : store
                    .setStageExecutionStatus(worktreePath, {
                      planId,
                      stageId: update.stageId,
                      agentId: update.agentId,
                      status,
                      message: update.message,
                      expectedStageFingerprint: update.stageFingerprint,
                    })
                    .pipe(
                      Effect.provide(persistence),
                      Effect.mapError(orchestrationPersistenceError),
                      Effect.asVoid,
                    );
            },
            onEvidence: (evidence) =>
              store
                .setCriterionStatusLatest(worktreePath, {
                  planId,
                  criterionId: evidence.criterionId,
                  status: evidence.status,
                  evidence: evidence.evidence,
                  stageId: evidence.stageId,
                  expectedStageFingerprint: evidence.stageFingerprint,
                })
                .pipe(
                  Effect.provide(persistence),
                  Effect.mapError(orchestrationPersistenceError),
                  Effect.asVoid,
                ),
            onCheckpoint: (checkpoint) =>
              store
                .writeOrchestrationCheckpoint(worktreePath, planId, checkpoint)
                .pipe(
                  Effect.provide(persistence),
                  Effect.mapError(orchestrationPersistenceError),
                ),
          },
        })
        .pipe(Effect.either);

      if (report._tag === "Left") {
        if (report.left._tag === "OrchestrationAlreadyRunningError") {
          yield* Effect.logWarning(report.left.message);
          return latestReport;
        }
        yield* recordOrchestrationFailure(
          sessionId,
          planId,
          report.left.message,
        ).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError(
              `Could not persist orchestration failure for ${planId}: ${String(cause)}`,
            ),
          ),
        );
        yield* Effect.logError(
          `Could not execute orchestration ${planId}: ${report.left.message}`,
        );
        return latestReport;
      }
      latestReport = report.right;

      const latest = yield* store
        .readDocument(worktreePath, session.id, session.activeChatId)
        .pipe(Effect.provide(persistence));
      const queuedAfter =
        latest?.id === planId
          ? queuedOrchestrationFingerprints(latest)
          : new Set<string>();
      const amendmentQueuedWork =
        agentIds === undefined &&
        [...queuedAfter].some((fingerprint) => !queuedBefore.has(fingerprint));
      if (amendmentQueuedWork) continue;

      yield* store
        .settleOrchestration(worktreePath, {
          planId,
          workersCompleted:
            latest?.id === planId && orchestrationStagesCompleted(latest),
        })
        .pipe(Effect.provide(persistence));
      return latestReport;
    }
  }).pipe(
    Effect.catchAllCause((cause) =>
      recordOrchestrationFailure(sessionId, planId, String(cause)).pipe(
        Effect.catchAllCause((persistenceCause) =>
          Effect.logError(
            `Could not persist orchestration failure for ${planId}: ${String(persistenceCause)}`,
          ),
        ),
        Effect.zipRight(
          Effect.logError(`Orchestration ${planId} failed: ${String(cause)}`),
        ),
        Effect.as(null),
      ),
    ),
  );

/** Attach to orchestration activity without starting, resuming, or retrying it. */
export const watchOrchestrationWorkers = (
  sessionId: string,
  planId: string,
  chatId: string,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const service = yield* OrchestrationService;
      const session = yield* SessionStore.get(sessionId).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (session?.worktreePath == null) {
        return service.watch(sessionId, planId, chatId);
      }
      const document = yield* PlanStore.readDocument(
        session.worktreePath,
        sessionId,
        chatId,
      );
      if (
        document === null ||
        document.id !== planId ||
        document.producingChatId !== chatId
      ) {
        return service.watch(sessionId, planId, chatId);
      }
      const checkpoints = yield* PlanStore.readOrchestrationCheckpoints(
        session.worktreePath,
        planId,
      );
      const restored = restoredOrchestrationSnapshot(
        sessionId,
        document,
        checkpoints,
      );
      const live = service.watch(sessionId, planId, chatId);
      return restored === null
        ? live
        : Stream.concat(Stream.make(restored), live);
    }),
  );

/**
 * After an orchestrator turn, dispatch any worker stages its amendment requeued
 * — with no approval gate. This is the auto-dispatch half of "amend in place":
 * the runner applies the amendment to the canonical document (reconciled, kept
 * in the executing lane), and this fires only when that document is an
 * approved/executing orchestration plan with at least one queued assigned stage
 * — precisely the state an in-turn amendment leaves. When existing workers are
 * still settling, that owning execution re-reads the canonical plan after its
 * worker lifecycle settles and drains newly queued work. A competing dispatch
 * loses the service's atomic plan claim and exits immediately; there is no
 * detached polling scheduler. A plain answer queues nothing, so nothing
 * dispatches. `executeOrchestration` merges checkpoints, so already-completed
 * stages are skipped and only the requeued/new workers run.
 */
const dispatchPendingOrchestration = (sessionId: string, chatId: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (session?.worktreePath == null) return;
    const chat = session.chats.find((candidate) => candidate.id === chatId);
    if (chat?.role !== "orchestrator") return;
    const document = yield* PlanStore.readDocument(
      session.worktreePath,
      session.id,
      chatId,
    );
    if (
      document === null ||
      !planUsesOrchestration(session, document) ||
      !["approved", "executing", "needs-verification"].includes(
        document.status,
      ) ||
      queuedOrchestrationFingerprints(document).size === 0
    ) {
      return;
    }
    yield* executeOrchestration(sessionId, document.id).pipe(Effect.forkDaemon);
  }).pipe(Effect.asVoid);

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
    const orchestrator = yield* newSessionOrchestrator(config);
    const route = sessionCreationDefaults(input.cli, config, orchestrator);
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
    const config = yield* ConfigService.get().pipe(
      Effect.orElseSucceed(() => null),
    );
    const orchestrator = yield* newSessionOrchestrator(config);
    const route = sessionCreationDefaults(input.cli, config, orchestrator);
    return yield* SessionStore.create(
      { ...input, cli: route.cli },
      route.options,
    );
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

/** The opencode binary discovery resolved, or null when it isn't usable. */
const opencodeBin = () =>
  DiscoveryService.list().pipe(
    Effect.orElseSucceed(() => []),
    Effect.map(
      (clis) => clis.find((c) => c.kind === "opencode")?.binPath ?? null,
    ),
  );

/**
 * The providers opencode resolves for the user, with each credential's origin.
 * Asked of the binary rather than stored by us, because the answer belongs to
 * the user's setup — env vars, `opencode auth login`, their `opencode.json`.
 * An unreachable opencode yields an empty list (the harness reads as
 * unconfigured), never an error. Exported for tests.
 */
export const opencodeListProviders = () =>
  Effect.flatMap(opencodeBin(), (binPath) =>
    Effect.promise(() => fetchOpencodeProviders(binPath)).pipe(
      Effect.map((ps) => ps ?? []),
    ),
  );

/**
 * Store an API key in OPENCODE's own credential file — not `SecretStore`, which
 * stays reserved for the Jingler bearer token. The key therefore also works in
 * a bare `opencode` shell, which is the whole point of respecting their BYOK.
 * Exported for tests.
 */
export const opencodeSetAuth = (providerId: string, key: string) =>
  Effect.flatMap(opencodeBin(), (binPath) =>
    Effect.promise(() => setOpencodeAuth(binPath, providerId, key)),
  );

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
    const orchestrator = yield* newSessionOrchestrator(config);
    const route = sessionCreationDefaults(input.cli, config, orchestrator);
    return yield* SessionStore.createFromIssue(
      { ...input, cli: route.cli },
      route.options,
    );
  });

/** `Sessions.linkIssue` handler — attach an issue (+ automations) to a live session. */
export const linkIssue = (input: {
  sessionId: string;
  issue: IssueSummary;
  automations: IssueAutomations;
}) =>
  Effect.gen(function* () {
    yield* SessionStore.setIssue(input.sessionId, {
      number: input.issue.number,
      url: input.issue.url,
      title: input.issue.title,
      labels: input.issue.labels.map((l) => ({ name: l.name, color: l.color })),
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
    if (!session?.worktreePath || session.issueNumber == null) {
      return yield* Effect.fail(
        new GitHubApiError({
          reason: "validation",
          message: "No linked issue to close",
        }),
      );
    }
    yield* GitHubApi.closeIssue(session.worktreePath, session.issueNumber);
  });

/** `Github.issue` handler — the full linked-issue view model for the Issue tab. */
export const githubIssue = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId);
    if (!session?.worktreePath || session.issueNumber == null) return null;
    return yield* GitHubApi.issueView(
      session.worktreePath,
      session.issueNumber,
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
    AssetService.list(worktree)
  )

/** `Asset.read` handler — one asset's contents, sandboxed to the session worktree. */
export const assetRead = (input: { sessionId: string; path: string }) =>
  Effect.flatMap(assetWorktree(input.sessionId), (worktree) =>
    AssetService.read(worktree, input.path),
  );

/** `Asset.write` handler — revision-guarded replacement in the session worktree. */
export const assetWrite = (input: {
  sessionId: string
  path: string
  text: string
  expectedRevision: string
}) =>
  Effect.flatMap(assetWorktree(input.sessionId), (worktree) =>
    AssetService.write(
      worktree,
      input.path,
      input.text,
      input.expectedRevision
    )
  )

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
        createConnection: async (target, onStatus) => {
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
                  createPr: (metadata) =>
                    run(
                      GitHubApi.prCreate(cwd, {
                        title: metadata.prTitle,
                        body: metadata.prBody,
                        base: session.baseBranch ?? "main",
                        draft: false,
                      }),
                    ),
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
  cli: "claude" | "codex" | "opencode",
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

const pluginById = (pluginId: string) =>
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
    if (!found.enabled) {
      // A disabled plugin runs no code, and that has to include commands the
      // renderer still remembers — otherwise the Settings switch is advisory.
      return Effect.fail(
        new PluginError({ pluginId, reason: `"${pluginId}" is disabled` }),
      );
    }
    return Effect.succeed(found);
  });

/**
 * The uniform refusal for anything that needs a running extension host.
 *
 * Phrased as a capability the app does not have YET rather than as a fault of
 * the plugin, because that is what the operator will read in a toast. It also
 * keeps every unimplemented plugin path failing identically, so the renderer's
 * error handling is written against one shape instead of four.
 */
const notYetHosted = (pluginId: string, verb: string) =>
  Effect.fail(
    new PluginError({
      pluginId,
      reason: `Cannot ${verb} "${pluginId}" — the plugin extension host is not running in this build.`,
    }),
  );

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

/**
 * Handlers for every procedure in the group. Each one delegates straight to an
 * Effect service, so the group remains the sole contract. `Discovery.list`
 * pulls in a `CommandExecutor` requirement (via `DiscoveryService.list()`) that
 * `AppLayer` satisfies with the Node platform layer.
 */
let failGitHubFeedbackMarkOnce =
  process.env.JINGLER_E2E_GITHUB_FAIL_MARK_ONCE === "1";

const CoreHandlersLayer = JinglerCoreRpcs.toLayer({
  "Billing.paths": () => billingPaths,
  "Discovery.list": () => DiscoveryService.list(),
  "Config.get": configGet,
  "Setup.chooseReposDir": chooseReposDir,
  "Workspace.repos": () => WorkspaceService.listRepos(),
  "Workspace.branches": ({ repoPath }) => WorkspaceService.branches(repoPath),
  "Workspace.files": ({ repoPath }) => WorkspaceService.files(repoPath),
  "Workspace.revertFile": (input) => workspaceRevertFile(input),
  "Workspace.revertLines": (input) => workspaceRevertLines(input),
  "Sessions.list": () => SessionStore.list(),
  "Sessions.get": ({ id }) => SessionStore.get(id),
  "Sessions.create": (input) => createSession(input),
  "Sessions.createFromPr": (input) => createSessionFromPr(input),
  "Sessions.createFromIssue": (input) => createSessionFromIssue(input),
  "Sessions.linkIssue": (input) => linkIssue(input),
  "Sessions.unlinkIssue": ({ sessionId }) => unlinkIssue(sessionId),
  "Sessions.clearInitialPrompt": ({ sessionId }) =>
    Effect.gen(function* () {
      yield* SessionStore.clearInitialPrompt(sessionId);
      return yield* SessionStore.get(sessionId);
    }),
  "Sessions.archive": ({ sessionId, reason }) =>
    archiveSession(sessionId, reason),
  "Sessions.restore": ({ sessionId }) => restoreSession(sessionId),
  "Sessions.retitle": ({ sessionId }) =>
    retitleSession(sessionId, claudeTitleGenerator),
  "Sessions.rename": ({ sessionId, title }) => renameSession(sessionId, title),
  "Sessions.setStatus": ({ sessionId, status }) =>
    setSessionStatus(sessionId, status),
  "Sessions.setPersistent": ({ sessionId, persistent }) =>
    setSessionPersistent(sessionId, persistent),
  "Sessions.delete": ({ sessionId }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId).pipe(
        Effect.orElseSucceed(() => null),
      );
      const relayRoute = yield* GitHubAuth.sessionRoutes().pipe(
        Effect.map(
          (routes) =>
            routes.find((candidate) => candidate.sessionId === sessionId) ??
            null,
        ),
        Effect.orElseSucceed(() => null),
      );
      const runner = yield* AgentRunner;
      const orchestration = yield* OrchestrationService;
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
      yield* orchestration.stopSession(sessionId);
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
  "Sessions.setOrchestratorEnabled": ({
    sessionId,
    chatId,
    orchestratorEnabled,
  }) =>
    SessionStore.setOrchestratorEnabled(
      sessionId,
      chatId,
      orchestratorEnabled,
    ).pipe(
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
  "Sessions.diff": ({ id }) => sessionDiff(id),
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
      Effect.map(AgentRunner, (runner) => {
        let amendmentApplied = false;
        return runner
          .prompt(
            sessionId,
            chatId,
            text,
            images ?? [],
            reasoning,
            undefined,
            externalInstruction,
            displayText,
          )
          .pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                if (event._tag === "PlanUpdated") amendmentApplied = true;
              }),
            ),
            // `PlanUpdated` is the observable applied-amendment tag. Only that
            // outcome can have requeued work; not-present, invalid, and conflict
            // turns must not probe or dispatch orchestration after settling.
            Stream.concat(
              Stream.drain(
                Stream.fromEffect(
                  Effect.suspend(() =>
                    amendmentApplied
                      ? dispatchPendingOrchestration(sessionId, chatId)
                      : Effect.void,
                  ),
                ),
              ),
            ),
          );
      }),
    ),
  "Agent.decideGate": ({ sessionId, chatId, gateId, decision }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.decideGate(sessionId, chatId, gateId, decision),
    ),
  "Agent.answerQuestion": ({ sessionId, chatId, requestId, answers }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.answerQuestion(sessionId, chatId, requestId, answers),
    ),
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
    Effect.gen(function* () {
      const runner = yield* AgentRunner;
      const before = yield* SessionStore.get(sessionId).pipe(
        Effect.orElseSucceed(() => null),
      );
      const document =
        before === null ? null : yield* canonicalPlanForSession(before, planId);
      if (
        before !== null &&
        document !== null &&
        planUsesOrchestration(before, document) &&
        (yield* OrchestrationService.isPlanRunning(sessionId, planId))
      ) {
        return {
          status: "refused" as const,
          message:
            "Approval refused because this plan still has live workers. Stop them or wait for them to settle before approving the amendment.",
          latestRevision: document.revision,
        };
      }
      const result = yield* runner.approvePlan(
        sessionId,
        planId,
        executionMode,
        revision,
      );
      if (result.status !== "accepted") return result;
      const session = yield* SessionStore.get(sessionId).pipe(
        Effect.orElseSucceed(() => null),
      );
      const approvedDocument =
        session === null
          ? null
          : yield* canonicalPlanForSession(session, planId);
      if (
        session !== null &&
        approvedDocument !== null &&
        planUsesOrchestration(session, approvedDocument)
      ) {
        yield* executeOrchestration(sessionId, planId).pipe(Effect.forkDaemon);
      }
      return result;
    }),
  "Agent.resumePlan": ({ sessionId, chatId, planId, revision }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const runner = yield* AgentRunner;
        const session = yield* SessionStore.get(sessionId).pipe(
          Effect.orElseSucceed(() => null),
        );
        const document =
          session === null
            ? null
            : yield* canonicalPlanForSession(session, planId);
        const orchestrating =
          session !== null &&
          document !== null &&
          planUsesOrchestration(session, document);
        if (
          orchestrating &&
          (yield* OrchestrationService.isPlanRunning(sessionId, planId))
        ) {
          const events: ReadonlyArray<StreamEvent> = [
            {
              _tag: "Failed",
              message:
                "Resume refused because this plan still has live workers. Stop them or wait for them to settle before resuming it.",
            },
          ];
          return Stream.fromIterable(events);
        }
        if (!orchestrating) {
          return runner.resumePlan(sessionId, chatId, planId, revision);
        }
        const approval = yield* runner.approvePlan(
          sessionId,
          planId,
          undefined,
          revision,
        );
        if (approval.status === "refused") {
          const events: ReadonlyArray<StreamEvent> = [
            {
              _tag: "Failed",
              message: approval.message,
            },
          ];
          return Stream.fromIterable(events);
        }
        yield* executeOrchestration(sessionId, planId).pipe(Effect.forkDaemon);
        const events: ReadonlyArray<StreamEvent> = [
          {
            _tag: "Assistant",
            text: "Resumed the assigned worker agents from their latest checkpoints.",
          },
          { _tag: "Done", costUsd: 0, tokens: 0 },
        ];
        return Stream.fromIterable(events);
      }),
    ),
  "Agent.watchWorkers": ({ sessionId, planId, chatId }) =>
    watchOrchestrationWorkers(sessionId, planId, chatId),
  "Agent.stopWorker": ({ sessionId, planId, agentId }) =>
    Effect.flatMap(OrchestrationService, (service) =>
      service.stopWorker({ sessionId, planId, agentId }),
    ),
  "Agent.retryWorker": ({ sessionId, planId, agentId }) =>
    executeOrchestration(sessionId, planId, [agentId]).pipe(Effect.asVoid),
  "Agent.setHarness": ({ sessionId, chatId, cli, model }) =>
    SessionStore.setHarness(sessionId, chatId, cli, model).pipe(
      Effect.andThen(SessionStore.get(sessionId)),
    ),
  "Agent.stop": ({ sessionId, chatId }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.stop(sessionId, chatId)),
  // Not `AgentRunner.stop` scoped smaller: that halts the whole turn. A
  // sub-agent is killed through the run's own per-task handle, which is what
  // `BackgroundTaskStore` holds.
  "Agent.stopSubagent": ({ sessionId, chatId, agentId }) =>
    BackgroundTaskStore.stopHandled(sessionId, chatId, agentId),
  "Agent.steer": ({ sessionId, chatId, text, images }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.steer(sessionId, chatId, text, images),
    ),
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
  "Opencode.listProviders": () => opencodeListProviders(),
  "Opencode.setAuth": ({ providerId, key }) => opencodeSetAuth(providerId, key),
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
  "Config.setOrchestratorEnabled": ({ orchestratorEnabled }) =>
    ConfigService.setOrchestratorEnabled(orchestratorEnabled),
  "Config.setFontScale": ({ fontScale }) =>
    ConfigService.setFontScale(fontScale),
  "Config.setDefaultCli": ({ cli }) => ConfigService.setDefaultCli(cli),
  "Config.setOrchestrator": (orchestrator) =>
    ConfigService.setOrchestrator(orchestrator),
  "Config.setWorkerRouting": (workerRouting) =>
    ConfigService.setWorkerRouting(workerRouting),
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
  "Github.listPrs": ({ repoPath, mine, search }) =>
    GitHubApi.listPrs(repoPath, { mine, search }),
  "Github.listIssues": ({ repoPath, mine, search }) =>
    GitHubApi.listIssues(repoPath, { mine, search }),
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
  "Plan.participants": ({ sessionId, planId }) =>
    planParticipants(sessionId, planId),
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
  "Github.createPr": ({ sessionId }) => githubPublish(sessionId),
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
    Effect.flatMap(PreviewViewService, (b) => b.openBrowser(sessionId, url, bounds)),
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
    Effect.flatMap(PreviewViewService, (b) => b.controlNavigate(sessionId, url)),
  "BrowserControl.screenshot": ({ sessionId }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlScreenshot(sessionId)),
  "BrowserControl.click": ({ sessionId, selector }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlClick(sessionId, selector)),
  "BrowserControl.type": ({ sessionId, selector, text }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlType(sessionId, selector, text)),
  "BrowserControl.readText": ({ sessionId }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlReadText(sessionId)),
  "BrowserControl.evaluate": ({ sessionId, expression }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlEvaluate(sessionId, expression)),
  "BrowserControl.waitForSelector": ({ sessionId, selector, timeoutMs }) =>
    Effect.flatMap(PreviewViewService, (b) =>
      b.controlWaitForSelector(sessionId, selector, timeoutMs)
    ),

  "Asset.read": (input) => assetRead(input),
  "Asset.write": (input) => assetWrite(input),
  "Asset.reveal": (input) => assetReveal(input),
  "Asset.openPdf": (input) => assetOpenPdf(input),
  "Asset.setPdfBounds": ({ sessionId, bounds }) =>
    Effect.flatMap(PreviewViewService, (b) => b.setFileBounds(sessionId, bounds)),
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
  // The registry half is live; the extension-host half is not. Everything that
  // needs a running plugin process — command dispatch, the event stream, auth
  // grants — is stubbed HERE rather than left out of the layer, because
  // `toLayer` demands a total handler map: an omission is a compile error, not
  // a missing feature. Each stub fails with the same `PluginError` the real
  // implementation will, so the renderer's error path is exercised from day one
  // instead of being written blind against a handler that never failed.

  "Plugins.list": () => PluginRegistry.list(),

  // `Stream.unwrap(Effect.map(...))`, not the accessor — the accessor form
  // yields a stream OF a stream and the renderer receives nothing. Same shape
  // as `Theme.watch` above, and for the same reason.
  "Plugins.watch": () =>
    Stream.unwrap(
      Effect.map(PluginRegistry, (p) =>
        // Every emission means the directory changed, so the resolution cache
        // `pluginById` keeps is stale by definition.
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
    Effect.gen(function* () {
      // Stop it BEFORE deleting its directory. A host half whose `deactivate`
      // touches its own files should find them there, and an uninstall that
      // leaves code running against a directory that no longer exists is a
      // stranger failure than one that stops it first.
      yield* deactivateQuietly(pluginId);
      yield* PluginRegistry.uninstall(pluginId);
      yield* PluginAuth.revokeAll(pluginId);
    }),

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

  "Plugins.authSessions": () => PluginAuth.list(),

  // An empty stream, not a failure: the renderer subscribes at startup and must
  // not spend its life retrying a channel that is merely quiet.
  "Plugins.events": () => Stream.empty,

  "Plugins.invoke": ({ pluginId, commandId, arg }) =>
    Effect.gen(function* () {
      const host = yield* PluginHost.get();
      const plugin = yield* pluginById(pluginId);
      return yield* Effect.tryPromise({
        try: () => host.invoke(plugin, commandId, arg),
        catch: (cause) =>
          cause instanceof PluginError
            ? cause
            : new PluginError({ pluginId, reason: String(cause) }),
      });
    }),

  "Plugins.activate": ({ pluginId }) =>
    Effect.gen(function* () {
      const host = yield* PluginHost.get();
      const plugin = yield* pluginById(pluginId);
      // A disabled plugin must not be woken by an event. The renderer stops
      // rendering its tabs when it is disabled, so it should not reach here — but
      // `onStartupFinished` dispatch iterates the catalog, and "disabled" has to
      // mean "runs no code" at every entry point rather than most of them.
      if (!plugin.enabled) return;
      yield* Effect.tryPromise({
        try: () => host.activate(plugin),
        catch: (cause) =>
          cause instanceof PluginError
            ? cause
            : new PluginError({ pluginId, reason: String(cause) }),
      });
    }),

  "Plugins.reload": ({ pluginId }) =>
    Effect.gen(function* () {
      const host = yield* PluginHost.get();
      const plugin = yield* pluginById(pluginId);
      yield* Effect.tryPromise({
        try: () => host.reload(plugin),
        catch: (cause) =>
          cause instanceof PluginError
            ? cause
            : new PluginError({ pluginId, reason: String(cause) }),
      });
    }),
  /**
   * Grant from the renderer — used by Settings to pre-authorise, and by the
   * e2e suite. The plugin-driven path goes through the extension host instead.
   */
  "Plugins.authGrant": ({ pluginId, providerId, scopes }) =>
    Effect.gen(function* () {
      const plugin = yield* pluginById(pluginId);
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
  | FileSystem.FileSystem
  | GitHubApi
  | GitHubAuth
  | GitHubEventStore
  | GitService
  | MemoryService
  | ModelsService
  | OpenConnectorApi
  | OpenConnectorService
  | OrchestrationService
  | Path.Path
  | PlanStore
  | PluginAuth
  | PluginHost
  | PluginRegistry
  | PreviewViewService
  | ReviewService
  | ReviewStore
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
