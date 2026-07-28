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
  AdversarialPlanService,
  AgentRunner,
  AssetService,
  AuthService,
  ConfigService,
  claudeTitleGenerator,
  DiscoveryService,
  fetchOpencodeProviders,
  filterVisible,
  GhService,
  GitService,
  ModelsService,
  OpenConnectorService,
  OpenConnectorApi,
  SecretStoreUnavailable,
  planDraftPost,
  billingPath,
  isScriptedEnv,
  subscriptionProbeFailed,
  hasSubscriptionAuth,
  resetSubscriptionCache,
  METERED_ENV_KEYS,
  PlanExecutor,
  PlanStore,
  PluginRegistry,
  PluginHost,
  PluginAuth,
  PlanRoundStore,
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
  RankingService,
  releaseSessionRun,
  reserveSessionRun,
  TranscriptStore,
  UsageService,
  WorkspaceService
} from "@jingler/cli-adapters"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import {
  applyStreamEvent,
  assistantMessage,
  ConfigError,
  ConnectorError,
  GhError,
  GitError,
  latestPlan,
  PlanError,
  planningReadiness,
  routeQuotaState,
  routeQuotaStatus,
  resolveFindings,
  resolveOrchestrator,
  ReviewError,
  reviewModelFor,
  PluginError,
  SessionNotFoundError,
  TASK_KINDS,
  userMessage
} from "@jingler/core"
import type {
  BrowserBounds,
  AdversarialReview,
  Attachment,
  CliKind,
  ExecutionMode,
  Message,
  OpenConnectorConfig,
  OpenConnectorDefaults,
  Plan,
  PlanRound,
  StreamEvent,
  VendorReach,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  IssueAutomations,
  IssueSummary,
  PluginCatalog,
  PrMergeMethod,
  ProviderConfig,
  ReviewComment,
  ReviewSubmitKind,
  ReasoningSetting,
  Session,
  SettledSessionStatus,
  ProviderModels,
  ProvidersConfig,
  Usage
} from "@jingler/core"
import { JinglerRpcs } from "@jingler/contracts"
import { AppPaths, CliAdapter } from "@jingler/cli-adapters"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { RpcServer } from "@effect/rpc"
import type { FromClientEncoded, FromServerEncoded } from "@effect/rpc/RpcMessage"
import { Effect, Layer, Mailbox, Option, Runtime, Stream } from "effect"
import type { WebContents } from "electron"
import { app, BrowserWindow, ipcMain, shell } from "electron"
import { showNotification, shouldNotify } from "./notifications.js"
import { PreviewViewService } from "./preview-view.js"
import { DialogService } from "./dialog.js"

/** The single IPC channel both directions of the RPC transport ride on. */
export const RPC_CHANNEL = "jingler/rpc"

/**
 * `Config.get` handler. A malformed or absent config folds to `null` so the
 * renderer treats it as "not configured yet" and shows first-run setup, rather
 * than surfacing a read error. Exported so its folding behaviour is unit-tested.
 */
export const configGet = () => ConfigService.get().pipe(Effect.orElseSucceed(() => null))

/**
 * `Setup.chooseReposDir` handler. Opens the native picker; a cancelled dialog (or
 * any failure) folds to `null`, otherwise the chosen dir is persisted and the new
 * config returned. Exported so the cancel/persist branches are unit-tested.
 */
export const chooseReposDir = () =>
  Effect.gen(function* () {
    const dialog = yield* DialogService
    const dir = yield* dialog.chooseDirectory()
    if (dir === null) return null
    return yield* ConfigService.setReposDir(dir)
  }).pipe(Effect.orElseSucceed(() => null))

/**
 * `Skills.list` handler. Resolves the session's harness + worktree (best-effort;
 * an unknown session falls back to Claude with no worktree) so `SkillsService`
 * can report the harness-appropriate skills for the `/` menu. Exported for tests.
 */
export const skillsList = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId).pipe(Effect.orElseSucceed(() => null))
    const cli = session?.cli ?? "claude"
    // The harness announces its own command list, so we need the binary discovery
    // resolved — a GUI-launched Electron app has a threadbare PATH, so the bare
    // name often isn't runnable (same reason `Models.list` takes it).
    const clis = yield* DiscoveryService.list().pipe(Effect.orElseSucceed(() => []))
    return yield* SkillsService.list({
      cli,
      // The operator's global skills live under the real home (~/.claude/skills),
      // never JINGLER_HOME.
      homeDir: homedir(),
      worktreePath: session?.worktreePath ?? null,
      binPath: clis.find((c) => c.kind === cli)?.binPath ?? null
    })
  })


/**
 * The Jingler-hosted OpenConnector URL used by packaged (prod) builds, overridable
 * via env for staging. PLACEHOLDER until the hosted instance ships — the mechanism
 * is here so prod points at it automatically the moment the URL is real.
 */
const HOSTED_OPEN_CONNECTOR_URL = process.env.JINGLER_OPEN_CONNECTOR_URL ?? "https://connect.jingler.app"

/** The dev instance the repo-root docker-compose serves, with its zero-setup token. */
const DEV_OPEN_CONNECTOR_URL = process.env.OPEN_CONNECTOR_BASE_URL ?? "http://localhost:3000"
const DEV_OPEN_CONNECTOR_TOKEN = process.env.OPEN_CONNECTOR_API_TOKEN ?? "local-dev-token"

/**
 * Environment-aware onboarding defaults. Only the main process knows
 * `app.isPackaged`, so this lives here rather than in the cli-adapters service.
 */
export const openConnectorDefaults = (): OpenConnectorDefaults =>
  // `app?.` because the unit-test env has no Electron `app`; there, dev is correct.
  app?.isPackaged
    ? { endpoint: HOSTED_OPEN_CONNECTOR_URL, kind: "hosted", hasDevToken: false }
    : { endpoint: DEV_OPEN_CONNECTOR_URL, kind: "local", hasDevToken: true }

/** `OpenConnector.get` handler — settings + a `hasToken` bool + onboarding defaults. */
export const openConnectorGet = () =>
  OpenConnectorService.get.pipe(Effect.map((r) => ({ ...r, defaults: openConnectorDefaults() })))

/**
 * `OpenConnector.autoSetup` handler — one-click onboarding. Dev fills the local
 * endpoint + dev token and enables; prod points at the hosted endpoint but leaves
 * it disabled (its token is provisioned separately — see docs/open-connector.md).
 */
export const openConnectorAutoSetup = () => {
  const d = openConnectorDefaults()
  const config = { endpoint: d.endpoint, enabled: d.kind === "local", serverName: "open-connector" }
  return openConnectorSet(config, d.hasDevToken ? DEV_OPEN_CONNECTOR_TOKEN : undefined)
}

/**
 * `OpenConnector.set` handler. The token can fail to persist when the OS vault is
 * unavailable; that surfaces as `SecretStoreUnavailable`, which is not an RPC
 * error type, so it's folded into `ConfigError` (the channel the panel handles).
 */
export const openConnectorSet = (config: OpenConnectorConfig, token: string | null | undefined) =>
  OpenConnectorService.set(config, token).pipe(
    Effect.catchIf(
      (e): e is SecretStoreUnavailable => e instanceof SecretStoreUnavailable,
      (e) => new ConfigError({ message: e.message, cause: e })
    )
  )

/** `OpenConnector.test` handler — live probe of the configured endpoint. */
export const openConnectorTest = () => OpenConnectorService.test

/**
 * `OpenConnector.injection` handler — what each harness would actually launch with,
 * resolved by the same service method the agent runner calls.
 */
export const openConnectorInjection = () => OpenConnectorService.injectionTargets

// ── MCP Connector Center handlers ────────────────────────────────────────────

/** `Connector.startOauth` — begin OAuth, opening the consent URL in the system browser. */
export const connectorStartOauth = (service: string, connectionName: string | undefined) =>
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
            catch: () => new ConnectorError({ message: "Couldn't open the authorization URL." })
          })
        : Effect.fail(new ConnectorError({ message: "OpenConnector returned a non-http(s) authorization URL." }))
    ),
    Effect.as({ ok: true, message: null } as const)
  )

/**
 * `Sessions.diff` handler. Resolves the session's worktree and returns its
 * unified working diff (empty when there's no worktree or the tree is clean, or
 * on any git failure — the Changes rail treats that as "no changes yet").
 * Exported for tests.
 */
export const sessionDiff = (id: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(id).pipe(Effect.orElseSucceed(() => null))
    if (!session?.worktreePath) return ""
    return yield* WorkspaceService.diff(session.worktreePath).pipe(Effect.orElseSucceed(() => ""))
  })

/** Resolve a session (best-effort; unknown → null) for the GitHub handlers. */
const resolveSession = (sessionId: string) =>
  SessionStore.get(sessionId).pipe(Effect.orElseSucceed(() => null))

type SessionWithPr = Session & { readonly prNumber: number }

const hasActivePr = (session: Session | null): session is SessionWithPr =>
  session !== null && session.prNumber !== null

const providerReasoning = (
  provider: ProviderConfig | undefined
): ReasoningSetting | undefined => {
  if (
    provider === undefined ||
    (provider.thinkingEnabled === undefined && provider.reasoningEffort === undefined)
  ) {
    return undefined
  }
  return {
    enabled: provider.thinkingEnabled ?? true,
    ...(provider.reasoningEffort === undefined ? {} : { effort: provider.reasoningEffort })
  }
}

/** Resolve a session only when it has an active pull request. */
const sessionWithPr = (sessionId: string) =>
  resolveSession(sessionId).pipe(
    Effect.map((session): SessionWithPr | null => (hasActivePr(session) ? session : null))
  )

/**
 * `Sessions.createFromPr` handler. Reads the git "share checked-out branches"
 * lever from config (default on) and passes it through, so a PR whose branch is
 * already checked out locally can be opened as a session when the user allows it.
 */
export const createSessionFromPr = (input: CreateSessionFromPrInput) =>
  Effect.gen(function* () {
    const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
    const allowSharedCheckout = config?.git?.shareCheckedOutBranches ?? true
    const provider = config?.providers?.[input.cli]
    return yield* SessionStore.createFromPr(input, {
      allowSharedCheckout,
      defaultMode: provider?.defaultMode,
      defaultModel: provider?.defaultModel,
      defaultReasoning: providerReasoning(provider)
    })
  })

/**
 * `Sessions.create` handler. Seeds the new session's permission mode + model
 * from the chosen CLI's configured provider defaults (Settings · Providers), so
 * a session opens in the mode/model the user picked. Absent config → the store
 * omits them and the harness applies its own defaults. Exported for tests.
 */
export const createSession = (input: CreateSessionInput) =>
  Effect.gen(function* () {
    const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
    const provider = config?.providers?.[input.cli]
    return yield* SessionStore.create(input, {
      defaultMode: provider?.defaultMode,
      defaultModel: provider?.defaultModel,
      defaultReasoning: providerReasoning(provider)
    })
  })

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
    const clis = yield* DiscoveryService.list()
    return yield* ModelsService.list(cli, clis.find((c) => c.kind === cli)?.binPath)
  })

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
    const clis = yield* DiscoveryService.list()
    const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
    const catalog = yield* ModelsService.catalog(clis)
    return catalog.map((section) => ({
      ...section,
      models: filterVisible(section.models, config?.providers?.[section.cli]?.visibleModels)
    }))
  })

/** The opencode binary discovery resolved, or null when it isn't usable. */
const opencodeBin = () =>
  DiscoveryService.list().pipe(
    Effect.orElseSucceed(() => []),
    Effect.map((clis) => clis.find((c) => c.kind === "opencode")?.binPath ?? null)
  )

/**
 * The providers opencode resolves for the user, with each credential's origin.
 * Asked of the binary rather than stored by us, because the answer belongs to
 * the user's setup — env vars, `opencode auth login`, their `opencode.json`.
 * An unreachable opencode yields an empty list (the harness reads as
 * unconfigured), never an error. Exported for tests.
 */
export const opencodeListProviders = () =>
  Effect.flatMap(opencodeBin(), (binPath) =>
    Effect.promise(() => fetchOpencodeProviders(binPath)).pipe(Effect.map((ps) => ps ?? []))
  )

/**
 * Store an API key in OPENCODE's own credential file — not `SecretStore`, which
 * stays reserved for the Jingler bearer token. The key therefore also works in
 * a bare `opencode` shell, which is the whole point of respecting their BYOK.
 * Exported for tests.
 */
export const opencodeSetAuth = (providerId: string, key: string) =>
  Effect.flatMap(opencodeBin(), (binPath) =>
    Effect.promise(() => setOpencodeAuth(binPath, providerId, key))
  )

/**
 * `Sessions.createFromIssue` handler. Like `createSession` (fresh branch, same
 * provider-default seeding) but links the issue + automations and seeds the task
 * from the issue. Exported for tests.
 */
export const createSessionFromIssue = (input: CreateSessionFromIssueInput) =>
  Effect.gen(function* () {
    const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
    const provider = config?.providers?.[input.cli]
    return yield* SessionStore.createFromIssue(input, {
      defaultMode: provider?.defaultMode,
      defaultModel: provider?.defaultModel,
      defaultReasoning: providerReasoning(provider)
    })
  })

/** `Sessions.linkIssue` handler — attach an issue (+ automations) to a live session. */
export const linkIssue = (input: {
  sessionId: string
  issue: IssueSummary
  automations: IssueAutomations
}) =>
  Effect.gen(function* () {
    yield* SessionStore.setIssue(input.sessionId, {
      number: input.issue.number,
      url: input.issue.url,
      title: input.issue.title,
      labels: input.issue.labels.map((l) => ({ name: l.name, color: l.color })),
      automations: input.automations
    })
    return yield* SessionStore.get(input.sessionId)
  })

/** `Sessions.unlinkIssue` handler — detach the session's issue. */
export const unlinkIssue = (sessionId: string) =>
  Effect.gen(function* () {
    yield* SessionStore.setIssue(sessionId, null)
    return yield* SessionStore.get(sessionId)
  })

/**
 * `Github.closeIssue` handler — close the session's linked issue (close-on-merge).
 * Fails with `GhError` when there's no worktree or linked issue.
 */
export const githubCloseIssue = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath || session.issueNumber == null) {
      return yield* Effect.fail(new GhError({ message: "No linked issue to close" }))
    }
    yield* GhService.closeIssue(session.worktreePath, session.issueNumber)
  })

/** `Github.issue` handler — the full linked-issue view model for the Issue tab. */
export const githubIssue = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath || session.issueNumber == null) return null
    return yield* GhService.issueView(session.worktreePath, session.issueNumber)
  })

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
      Effect.catchAll(() => new SessionNotFoundError({ sessionId }))
    )
    if (!session.worktreePath) return yield* new SessionNotFoundError({ sessionId })
    return session.worktreePath
  })

/** `Asset.read` handler — one asset's contents, sandboxed to the session worktree. */
export const assetRead = (input: { sessionId: string; path: string }) =>
  Effect.flatMap(assetWorktree(input.sessionId), (worktree) =>
    AssetService.read(worktree, input.path)
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
    const worktree = yield* assetWorktree(input.sessionId)
    const absolutePath = yield* AssetService.revealPath(worktree, input.path)
    yield* Effect.sync(() => shell.showItemInFolder(absolutePath))
  })

/**
 * `Asset.openPdf` handler — park Chromium's PDF viewer over the dock's rect.
 *
 * The absolute path is derived HERE, from the session's own worktree, rather
 * than accepted from the renderer. That keeps one containment check for both
 * doors into the filesystem: a renderer that could pass its own path would make
 * the native viewer a way around the check that guards `Asset.read`.
 */
export const assetOpenPdf = (input: {
  sessionId: string
  path: string
  bounds: BrowserBounds
}) =>
  Effect.gen(function* () {
    const worktree = yield* assetWorktree(input.sessionId)
    const absolutePath = yield* AssetService.pdfPath(worktree, input.path)
    yield* Effect.flatMap(PreviewViewService, (v) => v.openFile(absolutePath, input.bounds))
  })

/**
 * `Workspace.revertFile` handler — discard all uncommitted changes to `path` in
 * the session's worktree. A no-op for an unknown / worktree-less session.
 */
export const workspaceRevertFile = (input: { sessionId: string; path: string }) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath) return
    yield* WorkspaceService.revertFile(session.worktreePath, input.path)
  })

/**
 * `Workspace.revertLines` handler — revert just the uncommitted changes in a
 * line range of `path` in the session's worktree. No-op for an unknown session.
 */
export const workspaceRevertLines = (input: {
  sessionId: string
  path: string
  startLine: number
  endLine: number
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath) return
    yield* WorkspaceService.revertRange(
      session.worktreePath,
      input.path,
      input.startLine,
      input.endLine
    )
  })

/**
 * `Github.pr` handler. Returns the linked PR (via `gh pr view`) or null when the
 * session has no worktree or no linked PR. Exported for tests.
 */
export const githubPr = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath || session.prNumber === null) return null
    return yield* GhService.prView(session.worktreePath, session.prNumber)
  })

/**
 * `Github.prState` handler — the lifecycle state of a session's linked PR (or
 * null when there's no worktree / linked PR). Drives the archive sweep. Exported
 * for tests.
 */
export const githubPrState = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath || session.prNumber === null) return null
    return yield* GhService.prState(session.worktreePath, session.prNumber)
  })

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
    const tasks = yield* BackgroundTaskStore.list(sessionId)
    const file = tasks.find((t) => t.id === taskId)?.outputFile
    if (!file) return ""
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
  })

/** `Sessions.archive` handler — archive a session and return the updated record. */
export const archiveSession = (sessionId: string, reason: "merged" | "closed") =>
  Effect.gen(function* () {
    yield* SessionStore.archive(sessionId, reason)
    return yield* SessionStore.get(sessionId)
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(new GitError({ message: "Session not found" }))
    )
  )

/** `Sessions.restore` handler — un-archive a session and return the updated record. */
export const restoreSession = (sessionId: string) =>
  Effect.gen(function* () {
    yield* SessionStore.restore(sessionId)
    return yield* SessionStore.get(sessionId)
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(new GitError({ message: "Session not found" }))
    )
  )

/** `Sessions.rename` handler — pin a manual title and return the updated record. */
export const renameSession = (sessionId: string, title: string) =>
  Effect.gen(function* () {
    yield* SessionStore.renameTitle(sessionId, title)
    return yield* SessionStore.get(sessionId)
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(new GitError({ message: "Session not found" }))
    )
  )

/** `Sessions.setStatus` handler — record a settled turn's lifecycle status. */
export const setSessionStatus = (sessionId: string, status: SettledSessionStatus) =>
  Effect.gen(function* () {
    yield* SessionStore.setStatus(sessionId, status)
    return yield* SessionStore.get(sessionId)
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(new GitError({ message: "Session not found" }))
    )
  )

/** `Github.files` handler — the PR's changed files (empty without a linked PR). */
export const githubFiles = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath || session.prNumber === null) return []
    return yield* GhService.prFiles(session.worktreePath, session.prNumber)
  })

/** `Github.diff` handler — the PR's unified diff (empty without a linked PR). */
export const githubDiff = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath || session.prNumber === null) return ""
    return yield* GhService.prDiff(session.worktreePath, session.prNumber)
  })

/** `Review.get` handler — the stored review for the active PR, or null. */
export const reviewGet = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* sessionWithPr(sessionId)
    if (session === null) return null
    const review = yield* ReviewStore.get(sessionId)
    return review?.prNumber === session.prNumber ? review : null
  })

/**
 * Whether an installed provider is honest to advertise as executable.
 *
 * Discovery proves a binary exists, not that it can authenticate. Claude and
 * Codex therefore need either subscription auth or a metered key. A failed
 * credential probe stays eligible (unknown is safer than a false negative),
 * while a conclusive missing credential does not. Scripted mode is the
 * hermetic test harness and never spawns the discovered binary.
 */
export const providerCanRoute = (
  cli: CliKind,
  providers: ProvidersConfig | undefined,
  env: Record<string, string | undefined>,
  subscription: boolean,
  probeFailed: boolean,
  scripted: boolean
): boolean => {
  if (providers?.[cli]?.enabled === false) return false
  if (scripted) return true
  const keys = METERED_ENV_KEYS[cli]
  if (keys === undefined) return true
  return subscription || probeFailed || keys.some((key) => (env[key] ?? "").length > 0)
}

export const eligibleRoutingCatalog = (
  catalog: ReadonlyArray<ProviderModels>,
  providers: ProvidersConfig | undefined
): ReadonlyArray<ProviderModels> => {
  // Eligibility is an operator-triggered boundary: readiness, planning, and
  // execution must all observe a login completed in another terminal. Keep the
  // memo within this catalogue pass, but never carry its answer between passes.
  resetSubscriptionCache()
  return catalog.filter((provider) => {
    const subscription = hasSubscriptionAuth(provider.cli)
    return providerCanRoute(
      provider.cli,
      providers,
      process.env,
      subscription,
      subscriptionProbeFailed(provider.cli),
      isScriptedEnv()
    )
  })
}

/**
 * The live model catalogue, folded down to the labs this machine can reach.
 *
 * Shared by `Plan.readiness` and `Plan.adversarial` so the entry the operator
 * sees and the round that actually runs can never disagree about which vendors
 * exist — a readiness check computed from a different source than the run is a
 * button that lies.
 */
const quotaEligiblePlanningCatalog = (
  catalog: ReadonlyArray<ProviderModels>,
  usage: Usage
): ReadonlyArray<ProviderModels> =>
  catalog.map((provider) => ({
    ...provider,
    models: provider.models.filter(
      (model) => routeQuotaStatus({ cli: provider.cli, model: model.id }, usage) !== "limited"
    )
  }))

const readableList = (values: ReadonlyArray<string>): string =>
  values.length < 2
    ? (values[0] ?? "a configured route")
    : `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`

const planningVendors = Effect.gen(function* () {
  const clis = yield* DiscoveryService.list()
  const discoveredCatalog = yield* ModelsService.catalog(clis)
  const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
  const catalog = eligibleRoutingCatalog(discoveredCatalog, config?.providers)
  const usage = yield* UsageService.get(clis)
  const quotaCatalog = quotaEligiblePlanningCatalog(catalog, usage)
  const readiness = planningReadiness(quotaCatalog)
  const baseReadiness = planningReadiness(catalog)
  if (!readiness.ready && baseReadiness.ready) {
    const limitedRoutes = catalog.flatMap((provider) =>
      provider.models
        .filter(
          (model) => routeQuotaStatus({ cli: provider.cli, model: model.id }, usage) === "limited"
        )
        .map((model) => ({ cli: provider.cli, label: `${provider.label} · ${model.label}` }))
    )
    const limitedClis = new Set(limitedRoutes.map((route) => route.cli))
    const reset = usage.providers
      .filter((provider) => limitedClis.has(provider.cli))
      .flatMap((provider) =>
        provider.windows.flatMap((window) =>
          window.status === "limited" && window.resetsAt !== null ? [window.resetsAt] : []
        )
      )
      .sort()
      .at(-1)
    return {
      clis,
      catalog,
      config,
      usage,
      vendors: readiness.vendors,
      readiness: {
        ...readiness,
        reason:
          `Adversarial planning needs two model providers, but local usage limits remove ` +
          `${readableList(limitedRoutes.map((route) => route.label))}${
            reset === undefined ? "" : ` until ${reset}`
          }. ` +
          "Wait for the limit to reset or enable another route in Settings · Providers."
      }
    }
  }
  return {
    clis,
    catalog,
    config,
    usage,
    vendors: readiness.vendors,
    readiness
  }
})

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
  resetSubscriptionCache()
  const clis = yield* DiscoveryService.list()
  return clis
    .filter((c) => c.available && c.kind !== "jingler")
    .map((c) => {
      const subscription = hasSubscriptionAuth(c.kind)
      const keys = METERED_ENV_KEYS[c.kind] ?? []
      return {
        cli: c.kind,
        path: billingPath(c.kind, process.env, subscription, subscriptionProbeFailed(c.kind)),
        // A key WAS present and we withheld it — the case worth naming, because
        // it is the one that silently cost money before.
        keyWithheld: subscription && keys.some((k) => (process.env[k] ?? "").length > 0)
      }
    })
})

/**
 * `Plan.readiness` handler — can we offer adversarial planning, and if not, why not?
 *
 * Derived from `planningVendors` rather than re-running discovery, so the claim
 * the button makes and the vendors the round actually gets are the same
 * computation. Duplicating those two lines is exactly how a readiness check
 * drifts from the run it describes.
 */
export const planReadiness = Effect.map(planningVendors, ({ readiness }) => readiness)

type PlanExecuteEnv =
  | AppPaths
  | CommandExecutor.CommandExecutor
  | ConfigService
  | SessionStore
  | TranscriptStore
  | DiscoveryService
  | ModelsService
  | PlanExecutor
  | PlanStore
  | CliAdapter
  | UsageService
  | FileSystem.FileSystem
  | Path.Path

/**
 * `Plan.execute` handler — run an approved plan, step by step.
 *
 * The payoff for everything the round does: it decides WHO should do each piece
 * of work, and until this runs that decision is decoration.
 *
 * The plan is read back from the session's own transcript rather than passed in
 * from the renderer. The renderer holds a copy that may have been edited on
 * screen, and executing anything other than the artifact the operator actually
 * approved would make the audit trail a lie.
 */
export const planExecute = (
  sessionId: string,
  planId: string,
  executionMode?: ExecutionMode
): Stream.Stream<StreamEvent, PlanError, PlanExecuteEnv> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const session = yield* resolveSession(sessionId)
      if (!session?.worktreePath) {
        return Stream.fail(
          new PlanError({
            message: "This session has no worktree to work in."
          })
        )
      }
      const worktreePath = session.worktreePath
      // A plan is single-flight: a double-click on approve or a re-send would run
      // two executors over the same steps in the shared worktree, applying every
      // edit and command twice. Distinct chats/plans reserve distinct owners and
      // still run concurrently.
      const reservation = `plan:${planId}`
      const holder = {}
      const admitted = yield* reserveSessionRun(sessionId, reservation, holder)
      if (!admitted) {
        return Stream.fail(
          new PlanError({ message: "This plan is already executing." })
        )
      }
      yield* Effect.addFinalizer(() => releaseSessionRun(sessionId, reservation, holder))
      const persistedArtifact = yield* PlanStore.readArtifact(worktreePath)
      const migrationChat = session.chats.find(
        (chat) => chat.id === `c_${session.id}_1`
      )
      if (migrationChat !== undefined) {
        yield* TranscriptStore.adoptLegacy(session.id, migrationChat.id)
      }
      const validPersistedArtifact =
        persistedArtifact !== null &&
        persistedArtifact.sessionId === session.id &&
        session.chats.some((chat) => chat.id === persistedArtifact.producingChatId)
          ? persistedArtifact
          : null
      const artifact =
        validPersistedArtifact ??
        (yield* (migrationChat === undefined
          ? Effect.succeed([] as ReadonlyArray<Message>)
          : TranscriptStore.list(migrationChat.id)).pipe(
          Effect.orElseSucceed(() => [] as ReadonlyArray<Message>),
          Effect.map((messages) =>
            messages
              .flatMap((message) =>
                message.parts.flatMap((part) => part._tag === "Plan" ? [part.plan] : [])
              )
              .find((plan) => plan.id === planId && plan.structured !== false) ?? null
          ),
          Effect.flatMap((legacyPlan) =>
            legacyPlan === null
              ? Effect.succeed(null)
              : PlanStore.promote(
                  sessionId,
                  worktreePath,
                  migrationChat!.id,
                  legacyPlan
                )
          )
        ))
      if (artifact === null || artifact.plan.id !== planId) {
        return Stream.fail(
          new PlanError({
            message:
              "The structured session plan is unavailable. Regenerate the plan before executing it."
          })
        )
      }
      const chatId = artifact.producingChatId
      const messages = yield* TranscriptStore.list(chatId).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<Message>)
      )
      const located = messages.reduce<{ plan: Plan; messageId: string } | null>(
        (found, m) =>
          m.parts.reduce<{ plan: Plan; messageId: string } | null>(
            (inner, part) =>
              part._tag === "Plan" && part.plan.id === planId
                ? { plan: part.plan, messageId: m.id }
                : inner,
            found
          ),
        null
      )
      const plan = artifact.plan

      const clis = yield* DiscoveryService.list()
      const discoveredCatalog = yield* ModelsService.catalog(clis)
      const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
      const catalog = eligibleRoutingCatalog(discoveredCatalog, config?.providers)
      const usage = yield* UsageService.get(clis)
      // What this host can actually run, as (harness, model) pairs. The plan's
      // assignee is only a recommendation — it was written on whatever machine
      // reviewed the plan, and cannot conjure an install here.
      const executionRoutes = catalog.flatMap((provider) =>
        provider.models.map((model) => {
          const candidate = { cli: provider.cli, model: model.id }
          return { candidate, quota: routeQuotaState(candidate, usage) }
        })
      )
      const available = executionRoutes
        .filter((route) => route.quota.status !== "limited")
        .map((route) => route.candidate)
      const unavailable = executionRoutes.flatMap((route) =>
        route.quota.status !== "limited"
          ? []
          : [
              {
                ...route.candidate,
                reason:
                  route.quota.resetsAt === null
                    ? "quota limited (reset time unavailable)"
                    : `quota limited until ${route.quota.resetsAt}`
              }
            ]
      )

      // Approval and the run itself have to reach disk, for two separate
      // reasons. The plan is still `proposed` on the record until we say
      // otherwise, and `settleLoaded` rewrites a proposed plan to `stale` on the
      // next transcript load — so a plan that ran to completion would come back
      // looking like one that never started, and could be approved a second
      // time. The execution's own output needs persisting for the same reason
      // the round's did: streaming to the renderer is not a record of anything.
      const txCtx = yield* Effect.context<
        TranscriptStore | PlanStore | FileSystem.FileSystem | Path.Path | AppPaths
      >()
      const approvedArtifact = yield* PlanStore.updateArtifact(worktreePath, planId, (stored) => ({
        ...stored,
        status: "approved"
      }))
      if (approvedArtifact === null) {
        return Stream.fail(
          new PlanError({
            message: "This plan changed before execution began. Review the current plan and retry."
          })
        )
      }
      if (located !== null) {
        yield* TranscriptStore.patchById(chatId, located.messageId, (m) => ({
          ...m,
          parts: m.parts.map((p) =>
            p._tag === "Plan" && p.plan.id === planId
              ? ({
                  _tag: "Plan",
                  plan: { ...p.plan, status: "approved" as const }
                } as const)
              : p
          )
        })).pipe(Effect.ignore)
      }

      const now = yield* Effect.sync(() => new Date().toISOString())
      const maxN = messages.reduce((max, m) => {
        const n = Number(m.id.split("_").pop())
        return Number.isFinite(n) && n > max ? n : max
      }, 0)
      yield* TranscriptStore.append(
        chatId,
        userMessage(`u_${chatId}_${maxN + 1}`, `Approved: ${plan.summary}`, now, [])
      ).pipe(Effect.ignore)
      const assistantId = `a_${chatId}_${maxN + 2}`
      yield* TranscriptStore.append(chatId, assistantMessage(assistantId, now)).pipe(
        Effect.ignore
      )
      const persist = (event: StreamEvent) =>
        TranscriptStore.patchById(chatId, assistantId, (m) => applyStreamEvent(m, event)).pipe(
          Effect.provide(txCtx),
          Effect.ignore
        )

      const executor = yield* PlanExecutor
      if (executionMode !== undefined) {
        yield* SessionStore.setMode(sessionId, chatId, executionMode).pipe(Effect.ignore)
      }
      const persistPlanStep = (
        step: Plan["steps"][number],
        phase: "attempt" | "completion"
      ) => {
        const applyStep = (storedPlan: Plan): Plan => ({
          ...storedPlan,
          steps: storedPlan.steps.map((stored) =>
            stored.id !== step.id
              ? stored
              : phase === "attempt"
                ? { ...step, status: stored.status }
                : { ...step, status: "done" }
          )
        })
        const updateTranscript =
          located === null
            ? Effect.void
            : TranscriptStore.patchById(chatId, located.messageId, (message) => ({
                ...message,
                parts: message.parts.map((part) =>
                  part._tag === "Plan" && part.plan.id === planId
                    ? { _tag: "Plan" as const, plan: applyStep(part.plan) }
                    : part
                )
              }))
        return PlanStore.updateArtifact(worktreePath, planId, applyStep).pipe(
          Effect.zipRight(updateTranscript),
          Effect.provide(txCtx),
          Effect.ignore
        )
      }
      return executor
        .run({
          sessionId,
          repo: session.repo,
          branch: session.branch,
          cwd: session.worktreePath,
          plan,
          context: planExecutionContextFromTranscript(
            messages,
            located?.messageId ?? assistantId
          ),
          available,
          unavailable,
          // The orchestrator's own model backs any step the plan left unassigned —
          // the same identity Gigaplan speaks as, rather than an arbitrary pick.
          fallback: resolveOrchestrator(config),
          binPathFor: (cli: CliKind) => clis.find((c) => c.kind === cli)?.binPath ?? null,
          executionMode,
          // Wired, not just declared. `onStepDone` documents itself as the thing
          // that makes progress survive a crash mid-run, and nothing was passing
          // it — so a 12-step plan killed after step 9 came back with the plan
          // already marked `approved` (we do that before starting, so it can't be
          // re-approved), no record of which steps had run, and a half-applied
          // worktree. Ticking the step on the stored plan is what that comment
          // was promising.
          // `current` is a live-stream-only state. Attempts are durable, but a
          // process killed mid-step must reopen as resumable rather than running.
          onStepUpdated: (step) => persistPlanStep(step, "attempt"),
          onStepDone: (step) => persistPlanStep(step, "completion")
        })
        .pipe(
          // `ToolDelta` excluded for the reason `AgentRunner` excludes it: it ticks
          // constantly and every patch rewrites the whole transcript.
          Stream.tap((event) => (event._tag === "ToolDelta" ? Effect.void : persist(event)))
        )
    })
  )

/** The persisted round for a session — proposal, critique and revision. */
export const planRound = (sessionId: string) => PlanRoundStore.get(sessionId)

type PlanAdversarialEnv =
  | RankingService
  | UsageService
  | ConfigService
  | GitService
  | SessionStore
  | TranscriptStore
  | DiscoveryService
  | ModelsService
  | AdversarialPlanService
  | PlanRoundStore
  | PlanStore
  | CliAdapter
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  | AppPaths

const GIGAPLAN_INTAKE_LIMIT = 60_000
const EARLIER_INTAKE_TRUNCATED = "[earlier intake truncated]"

/** Keep a contiguous newest suffix, so a planner never starts inside a turn. */
const boundGigaplanIntake = (turns: ReadonlyArray<string>): string => {
  const body = turns.join("\n\n").trim()
  if (body.length <= GIGAPLAN_INTAKE_LIMIT) return body

  // Reserve room for the explanation before choosing turns, so the displayed
  // intake remains within the same bound after we say what was omitted.
  const turnBudget = GIGAPLAN_INTAKE_LIMIT - EARLIER_INTAKE_TRUNCATED.length - 2
  const retained: Array<string> = []
  let length = 0
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn === undefined) continue
    const separator = retained.length === 0 ? 0 : 2
    if (length + separator + turn.length > turnBudget) break
    retained.unshift(turn)
    length += separator + turn.length
  }

  return [EARLIER_INTAKE_TRUNCATED, ...retained].join("\n\n")
}

const latestGigaplanPlan = (messages: ReadonlyArray<Message>): Plan | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.source !== "gigaplan-handoff") continue
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]
      if (part?._tag === "Plan") return part.plan
    }
  }
  return null
}

/** Build the planner handoff from durable Gigaplan intake, never the working chat. */
export const gigaplanBriefFromTranscript = (messages: ReadonlyArray<Message>): string => {
  const turns = messages.flatMap((message) => {
    if (message.source !== "gigaplan-intake") return []
    const parts = message.parts.flatMap((part): ReadonlyArray<string> => {
      if (part._tag === "Text" && part.text.trim().length > 0) return [part.text.trim()]
      if (part._tag !== "Question") return []
      return part.request.questions.map((question, index) => {
        const answer = part.answers?.[index]
        const response = answer
          ? [...answer.selected, ...(answer.other ? [answer.other] : [])].join(", ")
          : "Unanswered"
        return `QUESTION: ${question.question}\nANSWER: ${response}`
      })
    })
    return parts.length === 0
      ? []
      : [`${message.role === "user" ? "OPERATOR" : "ORCHESTRATOR"}\n${parts.join("\n\n")}`]
  })
  const activePlan = latestGigaplanPlan(messages)
  if (activePlan !== null && activePlan.raw.trim().length > 0) {
    turns.push(`ACTIVE PLAN\n${activePlan.raw.trim()}`)
  }
  // Keep the newest context when an intake has become very long. The active
  // harness thread still holds the full discussion; the round needs a bounded
  // brief that does not crowd out its repository inspection.
  const bounded = boundGigaplanIntake(turns)
  return bounded.length === 0
    ? ""
    : `Create or update the implementation plan from this reviewed Gigaplan intake.\n\n${bounded}`
}

/**
 * Carry the task that produced a plan into its fresh execution sessions.
 *
 * Plan steps deliberately run with `resumeId: null`, and Codex receives no
 * parent-thread messages in that case. Keep only human-visible text and answered
 * questions, stop at the plan artifact, and exclude Gigaplan's synthetic handoff
 * turns. The approved plan itself is supplied separately by `stepPrompt`.
 */
export const planExecutionContextFromTranscript = (
  messages: ReadonlyArray<Message>,
  planMessageId: string
): string => {
  const planIndex = messages.findIndex((message) => message.id === planMessageId)
  const beforePlan = planIndex < 0 ? messages : messages.slice(0, planIndex)
  const turns = beforePlan.flatMap((message) => {
    if (message.source === "gigaplan-handoff") return []
    const parts = message.parts.flatMap((part): ReadonlyArray<string> => {
      if (part._tag === "Text" && part.text.trim().length > 0) return [part.text.trim()]
      if (part._tag !== "Question") return []
      return part.request.questions.map((question, index) => {
        const answer = part.answers?.[index]
        const response = answer
          ? [...answer.selected, ...(answer.other ? [answer.other] : [])].join(", ")
          : "Unanswered"
        return `QUESTION: ${question.question}\nANSWER: ${response}`
      })
    })
    if (parts.length === 0) return []
    return [
      `${message.role === "user" ? "OPERATOR" : "ASSISTANT"}\n${parts.join("\n\n")}`
    ]
  })
  return boundGigaplanIntake(turns)
}

const gigaplanImagesFromTranscript = (
  messages: ReadonlyArray<Message>
): ReadonlyArray<Attachment> => {
  const seen = new Set<string>()
  return messages
    .filter(
      (message) =>
        message.source === "gigaplan-intake" || message.source === "gigaplan-handoff"
    )
    .flatMap((message) =>
      message.parts.flatMap((part) => (part._tag === "Image" ? [part.attachment] : []))
    )
    .filter((attachment) => {
      if (seen.has(attachment.id)) return false
      seen.add(attachment.id)
      return true
    })
    .slice(-8)
}

/**
 * `Plan.adversarial` handler — run a planning round and stream its events.
 *
 * Resolves the session's worktree up front and fails fast without one: the roles
 * run read-only *in the repo*, and a round that can't read the code would produce
 * a plan invented from the brief alone, which is worse than no plan.
 */
export const planAdversarial = (
  sessionId: string,
  brief?: string,
  images: ReadonlyArray<Attachment> = [],
  requestedChatId?: string
): Stream.Stream<StreamEvent, PlanError, PlanAdversarialEnv> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const session = yield* resolveSession(sessionId)
      if (!session?.worktreePath) {
        return Stream.fail(
          new PlanError({
            message: "This session has no worktree to plan against."
          })
        )
      }
      const chatId =
        requestedChatId &&
        session.chats.some((chat) => chat.id === requestedChatId)
          ? requestedChatId
          : session.activeChatId
      // Planning is single-flight PER SESSION, not per chat: PlanStore keeps one
      // current-plan artifact per worktree (which a session's chats share), so
      // two concurrent planning rounds would clobber it — the second chat's
      // `promote` replaces the first's, and approving the first then fails with
      // the artifact gone. A constant owner refuses any second round in the
      // session until the artifact can hold more than one plan.
      const reservation = "planning"
      const holder = {}
      const admitted = yield* reserveSessionRun(sessionId, reservation, holder)
      if (!admitted) {
        return Stream.fail(
          new PlanError({
            message: "A planning round is already running in this session."
          })
        )
      }
      yield* Effect.addFinalizer(() => releaseSessionRun(sessionId, reservation, holder))
      if (chatId === `c_${session.id}_1`) {
        yield* TranscriptStore.adoptLegacy(sessionId, chatId)
      }
      const prior = yield* TranscriptStore.list(chatId).pipe(Effect.orElseSucceed(() => []))
      const explicitBrief = brief?.trim() ?? ""
      const roundBrief =
        explicitBrief.length > 0 ? explicitBrief : gigaplanBriefFromTranscript(prior)
      if (roundBrief.length === 0) {
        return Stream.fail(
          new PlanError({
            message: "Gigaplan needs an intake conversation before it can create a plan."
          })
        )
      }
      const roundImages =
        images.length > 0 ? images : gigaplanImagesFromTranscript(prior)
      const { clis, catalog, config, usage, vendors } = yield* planningVendors
      const routingMode = config?.gigaplanRouting?.mode ?? "shadow"
      const ranking = routingMode === "active" ? yield* RankingService.latest : null
      const service = yield* AdversarialPlanService
      // Capture the store's context here so the persistence hook the service
      // calls later — on its own fiber, with only the adapter in scope — is a
      // fully-provided effect rather than one demanding an environment the
      // round doesn't have.
      const storeCtx = yield* Effect.context<
        PlanRoundStore | FileSystem.FileSystem | Path.Path | AppPaths
      >()
      // The transcript needs the same treatment, and for a sharper reason: the
      // round's plan has to LAND there. `Plan.execute` deliberately re-reads the
      // approved plan from the transcript rather than trusting the renderer's
      // copy, so a round that streams to the screen without persisting produces
      // a plan the operator can see, approve, and then be told is "no longer in
      // this session" — and loses the whole round on reopen. Streaming is not
      // persistence; `AgentRunner` is the only other thing that writes here, and
      // a round never goes through it.
      const txCtx = yield* Effect.context<
        TranscriptStore | FileSystem.FileSystem | Path.Path | AppPaths
      >()
      const now = yield* Effect.sync(() => new Date().toISOString())
      // Seed past any id already in the transcript, for the reason `AgentRunner`
      // does: ids are positional, and a round after a restart would otherwise
      // collide with earlier turns and stack rows keyed by the same id.
      const maxN = prior.reduce((max, m) => {
        const n = Number(m.id.split("_").pop())
        return Number.isFinite(n) && n > max ? n : max
      }, 0)
      // The brief, then an empty turn for the round to fold into — the same two
      // messages an ordinary send appends.
      yield* TranscriptStore.append(
        chatId,
        // Fresh attachments ride on the handoff turn, but transcript-derived
        // fallback images are already durable and must not be appended again.
        userMessage(
          `u_${chatId}_${maxN + 1}`,
          explicitBrief.length > 0
            ? explicitBrief
            : latestGigaplanPlan(prior) !== null
              ? "Update the plan from this Gigaplan conversation."
              : "Create a plan from this Gigaplan conversation.",
          now,
          images,
          "gigaplan-handoff"
        )
      ).pipe(Effect.ignore)
      const assistantId = `a_${chatId}_${maxN + 2}`
      yield* TranscriptStore.append(
        chatId,
        assistantMessage(assistantId, now, "gigaplan-handoff")
      ).pipe(
        Effect.ignore
      )
      const persist = (event: StreamEvent) =>
        // By id, not `patchLast`: the round is long, and nothing guarantees this
        // turn is still the final message by the time an event lands.
        TranscriptStore.patchById(chatId, assistantId, (m) => applyStreamEvent(m, event)).pipe(
          Effect.provide(txCtx),
          Effect.ignore
        )
      const binPathFor = (cli: CliKind) => clis.find((c) => c.kind === cli)?.binPath ?? null
      return service
        .run({
          sessionId,
          repo: session.repo,
          branch: session.branch,
          cwd: session.worktreePath,
          brief: roundBrief,
          images: roundImages,
          vendors,
          binPathFor,
          assignAgents: true,
          routing: {
            catalog,
            mode: routingMode,
            overrides: config?.gigaplanRouting?.overrides ?? [],
            systemDefault: resolveOrchestrator(config),
            ranking,
            usage,
            affinityEnabled: false
          },
          ...(session.cli === "claude" ||
          session.cli === "codex" ||
          session.cli === "opencode"
            ? { reasoning: session.reasoning?.[session.cli] }
            : {}),
          // Persistence is wired in here rather than inside the service so the
          // round logic stays free of the filesystem and testable without one.
          onRound: (round: PlanRound) => PlanRoundStore.set(round).pipe(Effect.provide(storeCtx))
        })
        .pipe(
          // Best-effort, like every other transcript write: a round the operator
          // watched succeed must not fail because a file could not be written.
          // `ToolDelta` is skipped for the reason `AgentRunner` skips it — it
          // ticks constantly and each patch rewrites the whole file.
          Stream.tap((event) =>
            event._tag === "PlanProposed"
              ? PlanStore.promote(
                  sessionId,
                  session.worktreePath!,
                  chatId,
                  event.plan
                ).pipe(Effect.zipRight(persist(event)))
              : event._tag === "ToolDelta"
                ? Effect.void
                : persist(event)
          )
        )
    })
  )

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
    const session = yield* sessionWithPr(sessionId)
    if (session === null) return null
    const review = yield* ReviewStore.get(sessionId)
    if (review === null || review.prNumber !== session.prNumber) return null
    if (review.routedAt !== null) return review.routedAt
    const now = yield* Effect.sync(() => new Date().toISOString())
    yield* ReviewStore.set(sessionId, { ...review, routedAt: now }).pipe(Effect.ignore)
    return now
  })

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
    const session = yield* sessionWithPr(sessionId)
    if (!session?.worktreePath) return null
    const review = yield* ReviewStore.get(sessionId)
    if (review === null || review.prNumber !== session.prNumber) return null

    const commits = yield* GitService.commitsSince(session.worktreePath, review.headSha)
    const now = yield* Effect.sync(() => new Date().toISOString())
    const findings = resolveFindings(review.findings, commits, now)
    // Identity, not deep equality: `resolveFindings` hands back the same array
    // when it attributed nothing, which is the fast path this leans on.
    if (findings === review.findings) return null

    const next = { ...review, findings }
    yield* ReviewStore.set(sessionId, next).pipe(Effect.ignore)
    return next
  })

/**
 * `Review.run` handler — run an adversarial review of the session's linked PR.
 *
 * The head-SHA short-circuit is the load-bearing part: it means an unchanged PR
 * costs one cheap `gh pr view` instead of an agent run. That is what lets the
 * auto-review trigger fire naively off the renderer's poll loop without needing
 * a client-side guard of its own — a duplicate effect is simply a no-op.
 *
 * Exported for tests.
 */
export const reviewRun = (sessionId: string, force: boolean) =>
  Effect.gen(function* () {
    const session = yield* sessionWithPr(sessionId)
    if (!session?.worktreePath) {
      return yield* Effect.fail(
        new ReviewError({
          message: "This session has no linked pull request to review."
        })
      )
    }

    const headSha = yield* GhService.prHeadSha(session.worktreePath, session.prNumber)
    if (headSha === null) {
      return yield* Effect.fail(
        new ReviewError({
          message: "Could not resolve the pull request's head commit."
        })
      )
    }

    // The de-dupe. Note it runs BEFORE the diff read and the agent spawn — the
    // whole point is that an unchanged head is nearly free.
    const prior = yield* ReviewStore.get(sessionId)
    if (
      !force &&
      prior !== null &&
      prior.prNumber === session.prNumber &&
      prior.headSha === headSha
    ) {
      return prior
    }

    const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
    const cli = config?.github?.reviewCli ?? "claude"
    const model = reviewModelFor(cli, config?.github?.reviewModel)

    const diff = yield* GhService.prDiff(session.worktreePath, session.prNumber)

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
      diff
    })

    // Post the minor/nit half to the PR as inline comments. The critical/major
    // half is NOT posted — it goes to the session's agent, which the renderer
    // does (it owns the conversation actor; this process has no way to reach it).
    //
    // Deliberately below the de-dupe: only a FRESH run posts. The short-circuit
    // above returns `prior` untouched, so a poll tick on an unchanged head can
    // never re-post the same nits.
    const posted = yield* postReviewToPr(session.worktreePath, session.prNumber, review, diff)

    // Persist best-effort: a review the user can see now matters more than one
    // we can re-read later, and a failed write must not fail the run.
    yield* ReviewStore.set(sessionId, posted).pipe(Effect.ignore)
    return posted
  })

/**
 * Post a review's low-severity findings to the PR, returning the review stamped
 * with the outcome.
 *
 * **Best-effort by construction.** A review costs real tokens on a frontier
 * model, and its verdict is just as true whether or not GitHub accepted the
 * comments — so every failure here lands in `postError` and the findings survive.
 * Failing the run instead would throw away the whole review over a `gh` hiccup,
 * and (because the caller persists only on success) leave the auto-trigger
 * re-running the reviewer on the same head every tick.
 */
const postReviewToPr = (
  cwd: string,
  prNumber: number,
  review: AdversarialReview,
  diff: string
): Effect.Effect<AdversarialReview, never, GhService | CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const plan = planReviewPost(review, diff)
    // Nothing low-severity to say. Not an error, and not a failed post — leave
    // both stamps null so the UI reads it as "there was nothing to post".
    if (plan === null) return review

    const now = yield* Effect.sync(() => new Date().toISOString())
    return yield* GhService.prReviewComments(cwd, prNumber, {
      commitSha: review.headSha,
      body: plan.body,
      comments: plan.comments
    }).pipe(
      Effect.as({ ...review, postedAt: now, postError: null }),
      Effect.catchAll((cause) =>
        Effect.succeed({
          ...review,
          postedAt: null,
          postError: `Couldn't post the low-severity findings to the pull request: ${cause.message}`
        })
      )
    )
  })

/**
 * `Github.detectPr` handler. Looks up a PR open on the session's branch and, when
 * found, links it (persists `prNumber`). Returns the number, or null. Exported for tests.
 */
export const githubDetectPr = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath) return null
    // Resolve against the worktree's live branch — the stored `session.branch`
    // drifts once the agent checks out / creates a different branch there.
    const n = yield* GhService.prForWorktree(session.worktreePath)
    if (n !== null && n !== session.prNumber) {
      yield* SessionStore.setPrNumber(session.id, n).pipe(Effect.ignore)
    }
    return n
  })

/** `Github.createPr` handler — open a PR from the session's branch and link it. */
export const githubCreatePr = (input: {
  sessionId: string
  title: string
  body: string
  base: string
  draft: boolean
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath) {
      return yield* Effect.fail(
        new GhError({ message: "Session has no worktree to open a PR from" })
      )
    }
    const n = yield* GhService.prCreate(session.worktreePath, {
      title: input.title,
      body: input.body,
      base: input.base,
      draft: input.draft
    })
    yield* SessionStore.setPrNumber(session.id, n).pipe(Effect.ignore)
    return n
  })

/**
 * `Github.comment` handler — post a top-level PR comment when `toGithub`. The
 * renderer separately feeds the body to the agent (`Agent.run`), so this only
 * owns the GitHub write.
 */
export const githubComment = (input: { sessionId: string; body: string; toGithub: boolean }) =>
  Effect.gen(function* () {
    if (!input.toGithub) return
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to comment on" }))
    }
    yield* GhService.prComment(session.worktreePath, session.prNumber, input.body)
  })

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
  sessionId: string
  comments: ReadonlyArray<ReviewComment>
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to review" }))
    }
    const headSha = yield* GhService.prHeadSha(session.worktreePath, session.prNumber)
    if (headSha === null) {
      return yield* Effect.fail(
        new GhError({
          message: "Couldn't resolve the pull request's head commit to anchor comments against"
        })
      )
    }
    const diff = yield* GhService.prDiff(session.worktreePath, session.prNumber)
    const plan = planDraftPost(input.comments, diff)
    if (plan === null) return 0

    yield* GhService.prReviewComments(session.worktreePath, session.prNumber, {
      commitSha: headSha,
      body: plan.body,
      comments: plan.comments
    })
    return plan.unanchoredCount
  })

/** `Github.review` handler — submit a review (comment/approve/request-changes). */
export const githubReview = (input: { sessionId: string; kind: ReviewSubmitKind; body: string }) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to review" }))
    }
    yield* GhService.prReview(session.worktreePath, session.prNumber, input.kind, input.body)
  })

/** `Github.resolveThread` handler — resolve/unresolve an inline review thread. */
export const githubResolveThread = (input: {
  sessionId: string
  threadId: string
  resolved: boolean
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath) {
      return yield* Effect.fail(new GhError({ message: "No worktree to resolve the thread from" }))
    }
    yield* GhService.resolveThread(session.worktreePath, input.threadId, input.resolved)
  })

/** `Github.replyToThread` handler — post a reply into an inline review thread. */
export const githubReplyToThread = (input: {
  sessionId: string
  commentId: number
  body: string
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to reply to" }))
    }
    yield* GhService.replyToThread(
      session.worktreePath,
      session.prNumber,
      input.commentId,
      input.body
    )
  })

/** `Github.merge` handler — merge the session's linked PR (merge commit by default). */
export const githubMerge = (input: { sessionId: string; method?: PrMergeMethod }) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to merge" }))
    }
    yield* GhService.prMerge(session.worktreePath, session.prNumber, input.method)
  })

/** `Github.markReady` handler — flip the session's draft PR to ready for review. */
export const githubMarkReady = (input: { sessionId: string }) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to mark ready" }))
    }
    yield* GhService.prReady(session.worktreePath, session.prNumber)
  })

/** `Github.updateBranch` handler — merge the base into the PR's head on GitHub. */
export const githubUpdateBranch = (input: { sessionId: string }) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to update" }))
    }
    yield* GhService.prUpdateBranch(session.worktreePath, session.prNumber)
  })

/**
 * `Terminal.create` handler. Resolves the terminal's working directory: an
 * explicit `cwd` wins, else the session's worktree, else the main-process cwd
 * (the service's own fallback). Keeping the resolution here means the renderer
 * can stay oblivious to worktree paths. Exported for tests.
 */
export const createTerminal = (input: {
  sessionId: string
  cwd?: string
  cols: number
  rows: number
}) =>
  Effect.gen(function* () {
    const cwd = input.cwd ?? (yield* resolveSession(input.sessionId))?.worktreePath ?? undefined
    const terminals = yield* TerminalService
    return yield* terminals.create({
      sessionId: input.sessionId,
      cwd,
      cols: input.cols,
      rows: input.rows
    })
  })

/**
 * Persist a per-session reasoning override without making the composer's
 * optimistic control wait on disk. The RPC remains best-effort, but a failed
 * sessions.json write must be visible in the main-process log: otherwise the
 * selection appears to work until the next restart and leaves no diagnosis.
 */
export const setReasoning = (
  sessionId: string,
  cli: "claude" | "codex" | "opencode",
  reasoning: Parameters<typeof SessionStore.setReasoning>[2]
) =>
  SessionStore.setReasoning(sessionId, cli, reasoning).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(
        `Failed to persist reasoning strength for session ${sessionId}: ${error.message}`
      )
    ),
    Effect.ignore
  )

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
let catalogCache: { at: number; catalog: PluginCatalog } | null = null

/** How long a resolved catalog is trusted between filesystem events. */
const CATALOG_CACHE_MS = 2_000

/** Dropped by the watcher, so an install or uninstall is visible immediately. */
export const invalidatePluginCatalog = (): void => {
  catalogCache = null
}

const cachedCatalog = Effect.suspend(() => {
  const now = Date.now()
  if (catalogCache && now - catalogCache.at < CATALOG_CACHE_MS) {
    return Effect.succeed(catalogCache.catalog)
  }
  return Effect.tap(PluginRegistry.list(), (catalog) =>
    Effect.sync(() => {
      catalogCache = { at: now, catalog }
    })
  )
})

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
    Effect.catchAll(() => Effect.void)
  )

const pluginById = (pluginId: string) =>
  Effect.flatMap(cachedCatalog, (catalog) => {
    const found = catalog.plugins.find((p) => p.manifest.id === pluginId)
    if (!found) {
      return Effect.fail(
        new PluginError({ pluginId, reason: `no plugin with id "${pluginId}" is installed` })
      )
    }
    if (!found.enabled) {
      // A disabled plugin runs no code, and that has to include commands the
      // renderer still remembers — otherwise the Settings switch is advisory.
      return Effect.fail(
        new PluginError({ pluginId, reason: `"${pluginId}" is disabled` })
      )
    }
    return Effect.succeed(found)
  })

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
      reason: `Cannot ${verb} "${pluginId}" — the plugin extension host is not running in this build.`
    })
  )

/** Where one plugin's private key/value blob lives. Confined by construction. */
const pluginStorageFile = (pluginId: string) =>
  Effect.gen(function* () {
    const paths = yield* AppPaths
    const path = yield* Path.Path
    const root = path.resolve(paths.pluginStorageDir)
    const file = path.resolve(root, `${pluginId}.json`)
    // The id is schema-constrained to kebab-case at the contract boundary, so
    // this can only fail if that guarantee is ever relaxed. Cheap to keep, and
    // the failure mode it prevents is writing anywhere on disk.
    if (path.dirname(file) !== root) {
      return yield* Effect.fail(
        new PluginError({ pluginId, reason: "plugin id escapes the storage directory" })
      )
    }
    return { root, file }
  })

const pluginStorageRead = (pluginId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { file } = yield* pluginStorageFile(pluginId)
    const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null))
    if (!raw) return {} as Record<string, unknown>
    return yield* Effect.try(() => JSON.parse(raw) as Record<string, unknown>).pipe(
      // A corrupt blob reads as empty rather than failing every subsequent get.
      // Plugin storage is a cache of the plugin's own state, not a record of
      // record — losing it costs a re-fetch, whereas a hard failure here would
      // wedge the plugin with no way for the operator to clear it.
      Effect.orElseSucceed(() => ({}) as Record<string, unknown>)
    )
  })

/**
 * Read one key. Declared never-failing in the contract, so every fault folds to
 * `null` — an unreadable store is indistinguishable from an unset key, which is
 * exactly what a caller asking "do you have this?" wants.
 */
export const pluginStorageGet = (pluginId: string, key: string) =>
  pluginStorageRead(pluginId).pipe(
    Effect.map((all) => all[key] ?? null),
    Effect.orElseSucceed(() => null)
  )

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
const storageLocks = new Map<string, Effect.Semaphore>()

const withStorageLock = <A, E, R>(
  pluginId: string,
  work: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Effect.sync(() => {
      const existing = storageLocks.get(pluginId)
      if (existing) return existing
      const created = Effect.unsafeMakeSemaphore(1)
      storageLocks.set(pluginId, created)
      return created
    }),
    (lock) => lock.withPermits(1)(work)
  )

/** Write the whole blob back. Shared by set and delete. */
const pluginStorageWrite = (pluginId: string, all: Record<string, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { root, file } = yield* pluginStorageFile(pluginId)
    yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.ignore)
    yield* fs.writeFileString(file, JSON.stringify(all, null, 2)).pipe(
      Effect.mapError(
        (cause) => new PluginError({ pluginId, reason: "could not write plugin storage", cause })
      )
    )
  })

export const pluginStorageSet = (pluginId: string, key: string, value: unknown) =>
  withStorageLock(
    pluginId,
    Effect.flatMap(pluginStorageRead(pluginId), (all) =>
      pluginStorageWrite(pluginId, { ...all, [key]: value })
    )
  )

/**
 * Remove a key.
 *
 * Not `set(key, null)`: a key present with a null value still appears in
 * `storageKeys`, so folding the two together would make a deleted key show up
 * in a listing forever.
 */
const pluginStorageDeleteUnlocked = (pluginId: string, key: string) =>
  Effect.flatMap(pluginStorageRead(pluginId), (all) => {
    if (!(key in all)) return Effect.void
    const { [key]: _removed, ...rest } = all
    return pluginStorageWrite(pluginId, rest)
  })

export const pluginStorageDelete = (pluginId: string, key: string) =>
  withStorageLock(pluginId, pluginStorageDeleteUnlocked(pluginId, key))

/** Declared never-failing: an unreadable store lists nothing, same as an empty one. */
export const pluginStorageKeys = (pluginId: string) =>
  pluginStorageRead(pluginId).pipe(
    Effect.map((all) => Object.keys(all)),
    Effect.orElseSucceed(() => [] as Array<string>)
  )

/**
 * Handlers for every procedure in the group. Each one delegates straight to an
 * Effect service, so the group remains the sole contract. `Discovery.list`
 * pulls in a `CommandExecutor` requirement (via `DiscoveryService.list()`) that
 * `AppLayer` satisfies with the Node platform layer.
 */
const HandlersLayer = JinglerRpcs.toLayer({
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
      yield* SessionStore.clearInitialPrompt(sessionId)
      return yield* SessionStore.get(sessionId)
    }),
  "Sessions.archive": ({ sessionId, reason }) => archiveSession(sessionId, reason),
  "Sessions.restore": ({ sessionId }) => restoreSession(sessionId),
  "Sessions.retitle": ({ sessionId }) => retitleSession(sessionId, claudeTitleGenerator),
  "Sessions.rename": ({ sessionId, title }) => renameSession(sessionId, title),
  "Sessions.setStatus": ({ sessionId, status }) => setSessionStatus(sessionId, status),
  "Sessions.delete": ({ sessionId }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId).pipe(
        Effect.orElseSucceed(() => null)
      )
      yield* SessionStore.remove(sessionId)
      for (const chat of session?.chats ?? []) {
        yield* TranscriptStore.remove(chat.id)
        yield* ContextManager.forget(chat.id)
      }
      if (session?.worktreePath) yield* PlanStore.removeAll(session.worktreePath)
      yield* ReviewStore.clear(sessionId)
    }),
  "Sessions.createChat": ({ sessionId }) =>
    SessionStore.createChat(sessionId).pipe(
      Effect.catchTag("SessionNotFoundError", (cause) =>
        Effect.fail(new GitError({ message: "Session not found", cause }))
      )
    ),
  "Sessions.selectChat": ({ sessionId, chatId }) =>
    SessionStore.selectChat(sessionId, chatId).pipe(
      Effect.catchTag("SessionNotFoundError", (cause) =>
        Effect.fail(new GitError({ message: "Session not found", cause }))
      )
    ),
  "Sessions.renameChat": ({ sessionId, chatId, title }) =>
    SessionStore.renameChat(sessionId, chatId, title).pipe(
      Effect.catchTag("SessionNotFoundError", (cause) =>
        Effect.fail(new GitError({ message: "Session not found", cause }))
      )
    ),
  "Sessions.closeChat": ({ sessionId, chatId }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId)
      if (!session.chats.some((chat) => chat.id === chatId)) return session
      const runner = yield* AgentRunner
      yield* runner.stop(sessionId, chatId)
      // Drop the closed chat's per-chat state so it can't leak or strand rows:
      // its background-task rows + stop handle (nothing else sweeps a chat that
      // never runs again), and the runner's per-chat maps (the lock in particular
      // grows one-per-chat for the life of the process).
      yield* BackgroundTaskStore.clearChat(sessionId, chatId)
      yield* runner.forgetChat(chatId)
      const updated = yield* SessionStore.closeChat(sessionId, chatId)
      yield* TranscriptStore.remove(chatId)
      yield* ContextManager.forget(chatId)
      if (session.worktreePath) {
        yield* PlanStore.rehomeArtifact(
          session.worktreePath,
          sessionId,
          chatId,
          updated.activeChatId
        )
      }
      return updated
    }).pipe(
      Effect.catchTag("SessionNotFoundError", (cause) =>
        Effect.fail(new GitError({ message: "Session not found", cause }))
      )
    ),
  "Sessions.transcript": ({ sessionId, chatId }) =>
    Effect.gen(function* () {
      const session = yield* SessionStore.get(sessionId)
      if (!session.chats.some((chat) => chat.id === chatId)) return []
      if (chatId === `c_${session.id}_1`) {
        yield* TranscriptStore.adoptLegacy(sessionId, chatId)
      }
      return yield* TranscriptStore.list(chatId)
    }).pipe(Effect.orElseSucceed(() => [])),
  "Sessions.diff": ({ id }) => sessionDiff(id),
  // The streaming agent seam: unwrap the runner's `Stream<StreamEvent>` so the
  // renderer subscribes to normalized events, harness-agnostic.
  "Agent.run": ({ sessionId, chatId, text, images, target, reasoning }) =>
    Stream.unwrap(
      Effect.map(AgentRunner, (runner) =>
        runner.prompt(
          sessionId,
          chatId,
          text,
          images ?? [],
          target ?? "session",
          reasoning
        )
      )
    ),
  "Agent.decideGate": ({ sessionId, chatId, gateId, decision }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.decideGate(sessionId, chatId, gateId, decision)
    ),
  "Agent.answerQuestion": ({ sessionId, chatId, requestId, answers }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.answerQuestion(sessionId, chatId, requestId, answers)
    ),
  "Agent.setMode": ({ sessionId, chatId, mode }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.setMode(sessionId, chatId, mode)),
  "Agent.setReasoning": ({ sessionId, cli, reasoning }) =>
    setReasoning(sessionId, cli, reasoning),
  "Agent.commentPlanStep": ({ sessionId, planId, stepId, body }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.commentPlanStep(sessionId, planId, stepId, body)
    ),
  "Agent.revisePlan": ({ sessionId, planId }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.revisePlan(sessionId, planId)),
  "Agent.approvePlan": ({ sessionId, planId, executionMode }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.approvePlan(sessionId, planId, executionMode)),
  "Agent.resumePlan": ({ sessionId, chatId, planId }) =>
    Stream.unwrap(
      Effect.map(AgentRunner, (runner) =>
        runner.resumePlan(sessionId, chatId, planId)
      )
    ),
  "Agent.setHarness": ({ sessionId, chatId, cli, model }) =>
    SessionStore.setHarness(sessionId, chatId, cli, model).pipe(Effect.ignore),
  "Agent.stop": ({ sessionId, chatId }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.stop(sessionId, chatId)),
  // Not `AgentRunner.stop` scoped smaller: that halts the whole turn. A
  // sub-agent is killed through the run's own per-task handle, which is what
  // `BackgroundTaskStore` holds.
  "Agent.stopSubagent": ({ sessionId, chatId, agentId }) =>
    BackgroundTaskStore.stopHandled(sessionId, chatId, agentId),
  "Agent.steer": ({ sessionId, chatId, text, images }) =>
    Effect.flatMap(AgentRunner, (runner) =>
      runner.steer(sessionId, chatId, text, images)
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
    OpenConnectorApi.putConnection(service, authType, { ...values }, connectionName),
  "Connector.disconnect": ({ service, connectionName }) =>
    OpenConnectorApi.deleteConnection(service, connectionName),
  "Connector.setOauthConfig": ({ provider, clientId, clientSecret, extra }) =>
    OpenConnectorApi.putOauthConfig(provider, clientId, clientSecret, extra ? { ...extra } : undefined),
  "Connector.startOauth": ({ service, connectionName }) => connectorStartOauth(service, connectionName),
  // Discovery supplies the CLI's resolved binary path — a GUI-launched Electron
  // app has a threadbare PATH, so Codex's own model list is only reachable via
  // the absolute path discovery found.
  "Models.list": ({ cli }) => modelsList(cli),
  "Models.catalog": () => modelsCatalog(),
  "Opencode.listProviders": () => opencodeListProviders(),
  "Opencode.setAuth": ({ providerId, key }) => opencodeSetAuth(providerId, key),
  "Usage.get": () => Effect.flatMap(DiscoveryService.list(), (clis) => UsageService.get(clis)),
  "Context.state": ({ sessionId, chatId }) =>
    ContextManager.bindContext(chatId, sessionId).pipe(
      Effect.zipRight(ContextManager.snapshot(chatId))
    ),
  // Fire-and-forget by design: the digest builds on a background fiber and lands
  // on the next turn, so the button returns instantly rather than parking the UI
  // on a summary the user is not waiting for.
  "Context.compactNow": ({ sessionId, chatId }) =>
    ContextManager.bindContext(chatId, sessionId).pipe(
      Effect.zipRight(ContextManager.compactNow(chatId))
    ),
  "Config.setContext": (context) => ConfigService.setContext(context),
  // Returns the updated session so the renderer can patch its cache without a
  // refetch, matching every other session mutation.
  "Sessions.setAutoCompact": ({ id, autoCompact }) =>
    SessionStore.setAutoCompact(id, autoCompact).pipe(
      Effect.zipRight(SessionStore.get(id)),
      Effect.catchTag("SessionNotFoundError", (cause) =>
        Effect.fail(new GitError({ message: "Session not found", cause }))
      )
    ),
  "Gh.status": () => GhService.status(),
  "Config.setGithub": (github) => ConfigService.setGithub(github),
  "Config.setGit": (git) => ConfigService.setGit(git),
  "Config.setNotifications": (notifications) => ConfigService.setNotifications(notifications),
  "Config.setPlanAutoRun": ({ planAutoRun }) => ConfigService.setPlanAutoRun(planAutoRun),
  "Config.setAdhdMode": ({ adhdMode }) => ConfigService.setAdhdMode(adhdMode),
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
          const win = BrowserWindow.getAllWindows()[0] ?? null
          if (
            !shouldNotify({
              kind,
              windowFocused: win?.isFocused() ?? false,
              isActiveSession,
              config: prefs
            })
          ) {
            return
          }
          showNotification({ sessionId, kind, title, body }, prefs)
        })
      )
    ),
  "Config.setStarredRepos": ({ paths }) => ConfigService.setStarredRepos(paths),
  "Config.setCollapsedRepos": ({ paths }) => ConfigService.setCollapsedRepos(paths),
  "Config.setLastRepoPath": ({ path }) => ConfigService.setLastRepoPath(path),
  "Config.setOrchestrator": ({ cli, model }) => ConfigService.setOrchestrator(cli, model),
  "Config.setGigaplanRouting": ({ routing }) => ConfigService.setGigaplanRouting(routing),
  "Config.setProvider": ({ cli, provider }) => ConfigService.setProvider(cli, provider),
  "Github.pr": ({ sessionId }) => githubPr(sessionId),
  "Github.prState": ({ sessionId }) => githubPrState(sessionId),
  "Github.listPrs": ({ repoPath, mine, search }) => GhService.listPrs(repoPath, { mine, search }),
  "Github.listIssues": ({ repoPath, mine, search }) =>
    GhService.listIssues(repoPath, { mine, search }),
  "Github.closeIssue": ({ sessionId }) => githubCloseIssue(sessionId),
  "Github.issue": ({ sessionId }) => githubIssue(sessionId),
  "Github.files": ({ sessionId }) => githubFiles(sessionId),
  "Github.diff": ({ sessionId }) => githubDiff(sessionId),
  "Github.detectPr": ({ sessionId }) => githubDetectPr(sessionId),
  "Plan.adversarial": ({ sessionId, chatId, brief, images }) =>
    planAdversarial(sessionId, brief, images ?? [], chatId),
  "Plan.round": ({ sessionId }) => planRound(sessionId),
  "Plan.current": ({ sessionId }) =>
    SessionStore.get(sessionId).pipe(
      Effect.flatMap((session) =>
        session.worktreePath
          ? PlanStore.readArtifact(session.worktreePath).pipe(
              Effect.map((artifact) =>
                artifact !== null &&
                artifact.sessionId === session.id &&
                session.chats.some((chat) => chat.id === artifact.producingChatId)
                  ? artifact
                  : null
              )
            )
          : Effect.succeed(null)
      ),
      Effect.orElseSucceed(() => null)
    ),
  "Plan.readiness": () => planReadiness,
  "Plan.execute": ({ sessionId, planId, executionMode }) =>
    planExecute(sessionId, planId, executionMode),
  "Review.run": ({ sessionId, force }) => reviewRun(sessionId, force),
  // Unwrapped from the service like `Terminal.attach` — the reviewer outlives any
  // one watcher, so the stream attaches to it rather than starting it.
  "Review.watch": ({ sessionId, chatId }) =>
    Stream.unwrap(Effect.map(ReviewService, (r) => r.watch(sessionId, chatId))),
  "Review.get": ({ sessionId }) => reviewGet(sessionId),
  "Review.markRouted": ({ sessionId }) => reviewMarkRouted(sessionId),
  "Review.reconcile": ({ sessionId }) => reviewReconcile(sessionId),
  "Github.createPr": (input) => githubCreatePr(input),
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
  "Terminal.kill": ({ terminalId }) => Effect.flatMap(TerminalService, (t) => t.kill(terminalId)),
  "Terminal.list": ({ sessionId }) => Effect.flatMap(TerminalService, (t) => t.list(sessionId)),

  // Background tasks — harness work that outlives the turn that started it.
  "BackgroundTasks.list": ({ sessionId }) => BackgroundTaskStore.list(sessionId),
  "BackgroundTasks.stop": ({ sessionId, taskId }) => BackgroundTaskStore.stop(sessionId, taskId),
  "BackgroundTasks.dismiss": ({ sessionId, taskId }) =>
    BackgroundTaskStore.dismiss(sessionId, taskId),
  "BackgroundTasks.output": ({ sessionId, taskId }) => backgroundTaskOutput(sessionId, taskId),

  // Browser preview — a native WebContentsView over a localhost dev server,
  // driven from the renderer's preview pane (bounds streamed to stay aligned).
  "BrowserPreview.open": ({ url, bounds }) =>
    Effect.flatMap(PreviewViewService, (b) => b.openBrowser(url, bounds)),
  "BrowserPreview.setBounds": ({ bounds }) =>
    Effect.flatMap(PreviewViewService, (b) => b.setBounds(bounds)),
  "BrowserPreview.navigate": ({ url }) =>
    Effect.flatMap(PreviewViewService, (b) => b.navigate(url)),
  "BrowserPreview.reload": () => Effect.flatMap(PreviewViewService, (b) => b.reload()),
  "BrowserPreview.setVisible": ({ visible }) =>
    Effect.flatMap(PreviewViewService, (b) => b.setVisible(visible)),
  "BrowserPreview.close": () => Effect.flatMap(PreviewViewService, (b) => b.close()),

  // Browser control — the SAME native view, driven by an agent (via the
  // browser-control MCP) so it can QA a preview URL where the operator watches.
  // Each op reveals the dock inside PreviewViewService.
  "BrowserControl.navigate": ({ url }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlNavigate(url)),
  "BrowserControl.screenshot": () =>
    Effect.flatMap(PreviewViewService, (b) => b.controlScreenshot()),
  "BrowserControl.click": ({ selector }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlClick(selector)),
  "BrowserControl.type": ({ selector, text }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlType(selector, text)),
  "BrowserControl.readText": () =>
    Effect.flatMap(PreviewViewService, (b) => b.controlReadText()),
  "BrowserControl.evaluate": ({ expression }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlEvaluate(expression)),
  "BrowserControl.waitForSelector": ({ selector, timeoutMs }) =>
    Effect.flatMap(PreviewViewService, (b) => b.controlWaitForSelector(selector, timeoutMs)),

  "Asset.read": (input) => assetRead(input),
  "Asset.reveal": (input) => assetReveal(input),
  "Asset.openPdf": (input) => assetOpenPdf(input),
  "Asset.hidePdf": () => Effect.flatMap(PreviewViewService, (b) => b.hideFile()),

  // Auth — the sign-in wall. Delegates to AuthService, which bridges the OS
  // keychain (SecretStore) and the BetterAuth backend.
  "Auth.getSession": () => AuthService.getSession(),
  "Auth.startSignIn": ({ provider }) => AuthService.startSignIn(provider),
  "Auth.sendMagicLink": ({ email, name }) => AuthService.sendMagicLink(email, name),
  "Auth.signOut": () => AuthService.signOut(),

  // Themes — the picker, the editor, and live reload of `~/jingler/themes`.
  "Theme.list": () => ThemeService.list(),
  "Theme.get": ({ id }) => ThemeService.get(id),
  "Theme.save": ({ id, theme }) => ThemeService.save(id, theme),
  "Theme.delete": ({ id }) => ThemeService.remove(id),
  "Theme.duplicate": ({ id, name }) => ThemeService.duplicate(id, name),
  "Theme.import": ({ json, name }) => ThemeService.importJson(json, name),
  "Theme.setActive": ({ id }) => ConfigService.setActiveTheme(id),
  "Theme.setCustomizations": ({ colors }) => ConfigService.setThemeCustomizations({ ...colors }),

  /**
   * `Stream.unwrap(Effect.map(…))`, NOT the `ThemeService.watch()` accessor.
   *
   * An `Effect` is itself a `Stream` of one element, so the accessor form —
   * `Effect<Stream<ThemeCatalog>>` — type-checks here and silently produces a
   * stream whose single element is the real stream. No error, no catalog, and
   * live reload just never fires. Same shape as `Review.watch` above, for the
   * same reason.
   */
  "Theme.watch": () => Stream.unwrap(Effect.map(ThemeService, (t) => t.watch())),

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
        const themesDir = resolve(paths.themesDir)
        const file = resolve(path)
        if (dirname(file) === themesDir) shell.showItemInFolder(file)
      })
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
        p.watch().pipe(Stream.tap(() => Effect.sync(invalidatePluginCatalog)))
      )
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
      yield* PluginRegistry.setEnabled(pluginId, enabled)
      if (!enabled) yield* deactivateQuietly(pluginId)
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
      yield* deactivateQuietly(pluginId)
      yield* PluginRegistry.uninstall(pluginId)
      yield* PluginAuth.revokeAll(pluginId)
    }),

  "Plugins.installFromFolder": ({ sourcePath }) =>
    PluginRegistry.installFromFolder(sourcePath),

  "Plugins.installFromPicker": () =>
    Effect.gen(function* () {
      const dialog = yield* DialogService
      const chosen = yield* dialog.chooseDirectory({
        title: "Install a plugin",
        message: "Choose a plugin folder — the one containing jingler.plugin.json.",
        // No "New Folder": a folder made in the picker is empty, and an empty
        // folder fails the manifest check a moment later. Offering the button
        // only invites that.
        allowCreate: false
      })
      // Cancelled. Not an error — see the contract for why this is a `null`
      // success rather than a `PluginError`.
      if (chosen === null) return null
      return yield* PluginRegistry.installFromFolder(chosen)
    }),

  // Confinement is the service's job (`dirFor` fails for anything that resolves
  // outside `pluginsDir`), so this handler cannot be tricked into revealing an
  // arbitrary path by a renderer that sends a crafted id.
  "Plugins.reveal": ({ pluginId }) =>
    Effect.flatMap(PluginRegistry.dirFor(pluginId), (dir) =>
      Effect.sync(() => {
        shell.showItemInFolder(dir)
      })
    ),

  "Plugins.storageGet": ({ pluginId, key }) => pluginStorageGet(pluginId, key),

  "Plugins.storageSet": ({ pluginId, key, value }) =>
    pluginStorageSet(pluginId, key, value),

  "Plugins.storageDelete": ({ pluginId, key }) => pluginStorageDelete(pluginId, key),

  "Plugins.storageKeys": ({ pluginId }) => pluginStorageKeys(pluginId),

  "Plugins.authSessions": () => PluginAuth.list(),

  // An empty stream, not a failure: the renderer subscribes at startup and must
  // not spend its life retrying a channel that is merely quiet.
  "Plugins.events": () => Stream.empty,

  "Plugins.invoke": ({ pluginId, commandId, arg }) =>
    Effect.gen(function* () {
      const host = yield* PluginHost.get()
      const plugin = yield* pluginById(pluginId)
      return yield* Effect.tryPromise({
        try: () => host.invoke(plugin, commandId, arg),
        catch: (cause) =>
          cause instanceof PluginError
            ? cause
            : new PluginError({ pluginId, reason: String(cause) })
      })
    }),

  "Plugins.activate": ({ pluginId }) =>
    Effect.gen(function* () {
      const host = yield* PluginHost.get()
      const plugin = yield* pluginById(pluginId)
      // A disabled plugin must not be woken by an event. The renderer stops
      // rendering its tabs when it is disabled, so it should not reach here — but
      // `onStartupFinished` dispatch iterates the catalog, and "disabled" has to
      // mean "runs no code" at every entry point rather than most of them.
      if (!plugin.enabled) return
      yield* Effect.tryPromise({
        try: () => host.activate(plugin),
        catch: (cause) =>
          cause instanceof PluginError
            ? cause
            : new PluginError({ pluginId, reason: String(cause) })
      })
    }),

  "Plugins.reload": ({ pluginId }) =>
    Effect.gen(function* () {
      const host = yield* PluginHost.get()
      const plugin = yield* pluginById(pluginId)
      yield* Effect.tryPromise({
        try: () => host.reload(plugin),
        catch: (cause) =>
          cause instanceof PluginError
            ? cause
            : new PluginError({ pluginId, reason: String(cause) })
      })
    }),
  /**
   * Grant from the renderer — used by Settings to pre-authorise, and by the
   * e2e suite. The plugin-driven path goes through the extension host instead.
   */
  "Plugins.authGrant": ({ pluginId, providerId, scopes }) =>
    Effect.gen(function* () {
      const plugin = yield* pluginById(pluginId)
      const session = yield* PluginAuth.getSession({
        pluginId,
        pluginName: plugin.manifest.name,
        providerId,
        scopes
      })
      if (!session) return null
      // Metadata only. The token stays in main — `AuthSessionInfo` has no field
      // for it, which is the boundary rather than an omission.
      const granted = yield* PluginAuth.list()
      return granted.find((g) => g.pluginId === pluginId && g.providerId === providerId) ?? null
    }),

  "Plugins.authRevoke": ({ pluginId, providerId }) =>
    PluginAuth.revoke(pluginId, providerId)
})

/**
 * There is exactly one renderer. We remember its `WebContents` from the most
 * recent inbound frame so the server can push responses back to it. Requests
 * always arrive after the window has loaded, so this is set before any `send`.
 */
let sender: WebContents | null = null

/**
 * A custom `RpcServer.Protocol` that pumps encoded frames over `ipcMain` /
 * `webContents.send`. `writeRequest` feeds an inbound client frame into the
 * server core; `send` ships a server response back to the renderer.
 */
const ServerProtocolLive = Layer.effect(
  RpcServer.Protocol,
  RpcServer.Protocol.make((writeRequest) =>
    Effect.gen(function* () {
      const disconnects = yield* Mailbox.make<number>()
      const runFork = Runtime.runFork(yield* Effect.runtime<never>())

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
      const webContentsWatched = new Set<number>()
      const watch = (contents: WebContents) => {
        if (webContentsWatched.has(contents.id)) return
        webContentsWatched.add(contents.id)
        const gone = () => disconnects.unsafeOffer(contents.id)
        contents.on("destroyed", () => {
          webContentsWatched.delete(contents.id)
          gone()
        })
        contents.on("render-process-gone", gone)
        // Covers reload: a reloading renderer keeps its `WebContents` (and so
        // its client id), so nothing else marks the old page's requests dead.
        // Same-document navigations are excluded — those keep the JS context,
        // and the client's fibers with it.
        contents.on("did-start-navigation", (details) => {
          if (details.isMainFrame && !details.isSameDocument) gone()
        })
      }

      ipcMain.on(RPC_CHANNEL, (event, data: FromClientEncoded) => {
        sender = event.sender
        watch(event.sender)
        runFork(writeRequest(event.sender.id, data))
      })

      return {
        disconnects,
        send: (_clientId: number, response: FromServerEncoded) =>
          Effect.sync(() => sender?.send(RPC_CHANNEL, response)),
        end: (_clientId: number) => Effect.void,
        clientIds: Effect.sync(() => new Set(sender ? [sender.id] : [])),
        initialMessage: Effect.succeed(Option.none()),
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false
      }
    })
  )
)

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
export const RpcServerLive = RpcServer.layer(JinglerRpcs).pipe(
  Layer.provide(HandlersLayer),
  Layer.provide(ServerProtocolLive)
)
