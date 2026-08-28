/**
 * The main-process Effect runtime. `AppLayer` wires every backend dependency the
 * RPC handlers need — the Node platform (`CommandExecutor` + `FileSystem` +
 * `Path`), the workspace/config/git/GitHub API/discovery/session services, the native
 * dialog + `~/jingler` path layers — and launches the RPC server.
 * `ManagedRuntime` keeps the layer's scope (forked server daemon + IPC listener)
 * alive for the lifetime of the app.
 */
import {
  AgentRunner,
  AgentResourcesLive,
  AgentTurnDriverLive,
  AssetService,
  AuthService,
  BrowserControlMcpServiceLive,
  ConfigService,
  ContextManager,
  EnvironmentService,
  RemoteBootstrapService,
  RemoteSessionService,
  GitHubApi,
  GitHubAuth,
  GitHubEventStore,
  GitService,
  MemoryServiceLive,
  MemoryAttachmentServiceLive,
  makePiAgentRuntimeLive,
  PiAgentRuntimeLive,
  ExplanationStore,
  PluginRegistry,
  PluginHost,
  PluginAuth,
  ProjectService,
  ReviewService,
  ReviewStore,
  SessionStore,
  OpenConnectorService,
  OpenConnectorApi,
  TerminalService,
  ThemeService,
  TranscriptStore,
  BackgroundTaskStore,
  UsageService,
  WorkspaceService,
  WebSearchCredentialService,
  WebSearchService,
  makeWebSearchService,
  RuntimeDiagnostics,
  RuntimeRecoveryService
} from "@jingler/cli-adapters"
import { NodeContext } from "@effect/platform-node"
import { Layer, ManagedRuntime } from "effect"
import { AppPathsLive } from "./app-paths.js"
import { PreviewViewServiceLive } from "./preview-view.js"
import { BrowserControlPortLive } from "./browser-control-port-live.js"
import { DialogServiceLive } from "./dialog.js"
import { RpcServerLive } from "./rpc.js"
import { ProviderConnectionsLive } from "./provider-connections-live.js"
import {
  configureE2ePiProvider,
  loadE2ePiFixture
} from "./e2e/pi-fixture.js"
import { configureE2ePiTools } from "./e2e/pi-fixture-tools.js"
import { PlaintextSecretStoreLive, SecretStoreLive } from "./secret-store.js"
import {
  PlaintextPluginSecretStoreLive,
  PluginSecretStoreLive
} from "./plugin-secret-store.js"

// e2e selects a plaintext file store (no OS keychain prompts under Playwright);
// every real build uses the keychain-backed store.
const SecretStoreLayer =
  process.env.JINGLER_SECRET_STORE === "memory"
    ? PlaintextSecretStoreLive
    : SecretStoreLive
const PluginSecretStoreLayer =
  process.env.JINGLER_SECRET_STORE === "memory"
    ? PlaintextPluginSecretStoreLive
    : PluginSecretStoreLive

/**
 * The per-session JSON stores under `~/jingler`. Independent peers — each needs
 * only FileSystem/Path/AppPaths — so they're merged into one `provide` rather
 * than chained. (`pipe` tops out at 20 arguments; grouping peers keeps headroom.)
 */
const StoreLayers = Layer.mergeAll(
  TranscriptStore.Default,
  BackgroundTaskStore.Default,
  ExplanationStore.Default,
  ReviewStore.Default
)

/**
 * The services that drive pi roles. `AgentRunner` owns conversations;
 * `ReviewService` runs adversarial review read-only; `ContextManager` compacts a
 * session transcript. All three share the canonical `AgentTurnDriver` seam.
 */
const RuntimeRoleLayers = Layer.mergeAll(
  AgentRunner.Default,
  // AgentRunner.Default also depends on this exact layer reference. Effect's
  // layer memoization therefore builds one app-lifetime MemoryService for both
  // runner captures and renderer RPCs, keeping the outbox lock and proxy shared.
  MemoryServiceLive,
  ReviewService.Default.pipe(
    Layer.provide(
      MemoryAttachmentServiceLive.pipe(Layer.provide(MemoryServiceLive))
    )
  ),
  ContextManager.Default
)

const AssetLayer: Layer.Layer<AssetService, never, never> =
  AssetService.Default.pipe(Layer.provide(NodeContext.layer))
const RuntimeDiagnosticsLive = RuntimeDiagnostics.Default

const e2ePiFixture = loadE2ePiFixture()
const EmbeddedPiRuntimeLive = e2ePiFixture === null
  ? PiAgentRuntimeLive
  : makePiAgentRuntimeLive({
      configureModelRuntime: configureE2ePiProvider(e2ePiFixture),
      configureToolRegistry: configureE2ePiTools
    })

const RemoteSessionsLive = RemoteSessionService.Default.pipe(
  Layer.provideMerge(
    EnvironmentService.Default.pipe(
      Layer.provide(RemoteBootstrapService.Default),
      Layer.provide(ProviderConnectionsLive)
    )
  )
)

const WebSearchLive = Layer.effect(
  WebSearchService,
  makeWebSearchService()
).pipe(
  Layer.provide(WebSearchCredentialService.Default),
  Layer.provide(SecretStoreLayer),
  Layer.provide(ConfigService.Default)
)

const PiRuntimeLayer = EmbeddedPiRuntimeLive.pipe(
  // These exact Default layer references are also retained by AppServicesLayer.
  // Effect memoizes them, so agent tool calls use the PluginHost instance main
  // installed rather than a private host with no Electron process factory.
  Layer.provide(PluginHost.Default),
  Layer.provide(PluginRegistry.Default),
  Layer.provide(SessionStore.Default),
  Layer.provide(RemoteSessionsLive),
  Layer.provide(WebSearchLive),
  Layer.provide(ConfigService.Default),
  Layer.provide(GitService.Default),
  Layer.provide(AssetLayer),
  Layer.provide(AgentResourcesLive),
  Layer.provide(ProviderConnectionsLive),
  Layer.provide(
    MemoryAttachmentServiceLive.pipe(Layer.provide(MemoryServiceLive))
  ),
  Layer.provide(ConfigService.Default),
  Layer.provide(SecretStoreLayer)
)

const AgentExecutionLayer = AgentTurnDriverLive.pipe(
  Layer.provideMerge(PiRuntimeLayer)
)

// Later `Layer.provide`s satisfy the requirements of earlier ones, so the leaf
// dependencies (paths, dialog, Node platform) come last.
const RpcServicesLayer = RpcServerLive.pipe(
  Layer.provideMerge(RuntimeRecoveryService.Default),
  Layer.provideMerge(AgentResourcesLive),
  Layer.provide(ProviderConnectionsLive),
  Layer.provide(RemoteSessionsLive),
  // AuthService requires SecretStore, satisfied by SecretStoreLive (merged below).
  Layer.provide(AuthService.Default),
  Layer.provideMerge(WebSearchCredentialService.Default),
  // Merged into one stage to stay inside `pipe`'s 20-argument limit. AssetService
  // captures the command executor used by its NUL-safe repository listing, so its
  // platform dependencies are provided at construction. Reusing NodeContext.layer
  // keeps Effect's memoized platform instance shared with the final app layer.
  Layer.provide(Layer.mergeAll(WorkspaceService.Default, ProjectService.Default, AssetLayer)),
  // Before SessionStore so the stores below satisfy the daemon's requirements —
  // a stage is provided-to by everything that follows it.
  // Merged so startup recovery can mark interrupted canonical plan revisions
  // stale through the same store instances the RPC handlers use.
  Layer.provideMerge(SessionStore.Default),
  Layer.provideMerge(StoreLayers),
  Layer.provide(RuntimeRoleLayers),
  // provideMerge (not provide): both app-lifetime services must stay in runtime
  // context. TerminalService is reached by the before-quit PTY reap; the browser
  // MCP service owns its scoped loopback listener and will be reached by the
  // run-scoped capability stage. They are independent peers, merged to remain inside
  // Effect.pipe's 20-argument limit. BrowserControlPort is supplied below.
  Layer.provideMerge(
    Layer.mergeAll(TerminalService.Default, BrowserControlMcpServiceLive)
  ),
  // provideMerge: the RPC auth handlers consume SecretStore AND the main process
  // reaches the same instance directly (deep-link token storage in index.ts).
  Layer.provideMerge(SecretStoreLayer),
  // provideMerge: the `Theme.*` handlers consume ThemeService AND the main
  // process reaches the very same instance at startup, to resolve the boot
  // theme before the window is constructed (see `boot-theme.ts`). That has to
  // happen outside the RPC surface by definition — there is no renderer yet.
  Layer.provideMerge(ThemeService.Default)
)

const AppServicesLayer = RpcServicesLayer.pipe(
  // Merged into one stage purely to stay inside `pipe`'s 20-argument limit;
  // neither depends on the other, so the composition is unchanged.
  Layer.provide(
    Layer.mergeAll(
      OpenConnectorService.Default,
      OpenConnectorApi.Default
    )
  ),
  // PluginHost needs provideMerge because main
  // installs the Electron-backed process factory into it at startup, so the RPC
  // handlers must later reach the SAME instance rather than a second one with
  // no way to spawn. And `.pipe` tops out at 20 arguments, which a separate
  // stage would have exceeded; all three are peers with no dependencies, so
  // merging changes nothing but the argument count.
  Layer.provideMerge(
    Layer.mergeAll(
      PluginHost.Default,
      // provideMerge for the same reason as PluginHost: main installs the
      // native consent prompt and the built-in github provider into it at
      // startup, so the RPC handlers must reach that same instance.
      PluginAuth.Default,
      PluginSecretStoreLayer,
      // And PluginRegistry, because the host's consent flow looks a plugin's
      // display name up from the catalog before prompting — the operator picked
      // it by name in Settings, so the prompt has to say the name.
      PluginRegistry.Default
    )
  ),
  Layer.provide(UsageService.Default),
  // GitHub is deliberately an HTTP/App-authenticated service. There is no
  // GitHub CLI layer in the runtime, so a machine's ambient PATH cannot become
  // a hidden credential or transport fallback.
  Layer.provide(GitHubApi.Default),
  Layer.provide(GitHubEventStore.Default),
  // Retained for the plugin-host provider as well as consumed by GitHubApi.
  // Supplying SecretStore here closes the layer locally; an outer provider
  // cannot consume services retained by the inner RPC layer.
  Layer.provideMerge(GitHubAuth.Default.pipe(Layer.provide(SecretStoreLayer))),
  // provideMerge: the `Config.*` handlers consume ConfigService AND the boot
  // theme resolution reads the active theme id from it before any window
  // exists.
  Layer.provideMerge(ConfigService.Default),
  Layer.provide(GitService.Default),
  Layer.provide(AgentExecutionLayer)
)

// Split from the service graph above so TypeScript does not collapse the input
// of this deeply nested layer pipeline to `any` at the ManagedRuntime boundary.
const AppLayer = AppServicesLayer.pipe(
  // Supply diagnostics at the composition root so the pi recorder and RPC
  // inspector are structurally guaranteed to share one app-lifetime service.
  Layer.provide(RuntimeDiagnosticsLive),
  // DialogService + the browser-control port, merged into ONE stage to stay
  // inside `pipe`'s 20-argument limit. They are peers (no interdependency); the
  // port's PreviewViewService requirement is satisfied by the NEXT stage. The
  // port is what lets AgentRunner build the agent's browser-control MCP against
  // the embedded browser (see agent-runner promptSetup).
  Layer.provide(Layer.mergeAll(DialogServiceLive, BrowserControlPortLive)),
  Layer.provide(PreviewViewServiceLive),
  // provideMerge so ThemeService/ConfigService stay callable from the runtime
  // directly (boot theme), not only from inside an RPC handler.
  Layer.provideMerge(AppPathsLive),
  // NodeContext bundles CommandExecutor + FileSystem + Path used by git, API,
  // config/workspace/session services.
  Layer.provideMerge(NodeContext.layer)
)

export const runtime = ManagedRuntime.make(AppLayer)
