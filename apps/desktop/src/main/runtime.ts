/**
 * The main-process Effect runtime. `AppLayer` wires every backend dependency the
 * RPC handlers need — the Node platform (`CommandExecutor` + `FileSystem` +
 * `Path`), the workspace/config/git/gh/discovery/session services, the native
 * dialog + `~/jingler` path layers — and launches the RPC server.
 * `ManagedRuntime` keeps the layer's scope (forked server daemon + IPC listener)
 * alive for the lifetime of the app.
 */
import {
  AgentRunner,
  AssetService,
  AuthService,
  BrowserControlMcpServiceLive,
  ConfigService,
  ContextManager,
  DiscoveryService,
  GhService,
  GitService,
  HarnessCliAdapterLive,
  ModelsService,
  MemoryServiceLive,
  OrchestrationService,
  PlanStore,
  PluginRegistry,
  PluginHost,
  PluginAuth,
  ReviewService,
  ReviewStore,
  SessionStore,
  OpenConnectorService,
  OpenConnectorApi,
  SkillsService,
  TerminalService,
  ThemeService,
  TranscriptStore,
  BackgroundTaskStore,
  UsageService,
  WorkspaceService
} from "@jingler/cli-adapters"
import { NodeContext } from "@effect/platform-node"
import { Layer, ManagedRuntime } from "effect"
import { AppPathsLive } from "./app-paths.js"
import { PreviewViewServiceLive } from "./preview-view.js"
import { BrowserControlPortLive } from "./browser-control-port-live.js"
import { DialogServiceLive } from "./dialog.js"
import { RpcServerLive } from "./rpc.js"
import { PlaintextSecretStoreLive, SecretStoreLive } from "./secret-store.js"

// e2e selects a plaintext file store (no OS keychain prompts under Playwright);
// every real build uses the keychain-backed store.
const SecretStoreLayer =
  process.env.JINGLER_SECRET_STORE === "memory" ? PlaintextSecretStoreLive : SecretStoreLive

/**
 * The per-session JSON stores under `~/jingler`. Independent peers — each needs
 * only FileSystem/Path/AppPaths — so they're merged into one `provide` rather
 * than chained. (`pipe` tops out at 20 arguments; grouping peers keeps headroom.)
 */
const StoreLayers = Layer.mergeAll(
  TranscriptStore.Default,
  BackgroundTaskStore.Default,
  PlanStore.Default,
  ReviewStore.Default
)

/**
 * The three things that drive a CLI harness. `AgentRunner` owns the session's
 * conversation; `ReviewService` drives the adapter itself so an adversarial
 * review can run on its own model, read-only, without touching that
 * conversation; `ContextManager` does the same to summarise a session's own
 * transcript when its working set outgrows the quality band. Peers — none
 * depends on the others, and all three reach the harness through `CliAdapter`.
 */
const HarnessLayers = Layer.mergeAll(
  AgentRunner.Default,
  // AgentRunner.Default also depends on this exact layer reference. Effect's
  // layer memoization therefore builds one app-lifetime MemoryService for both
  // runner captures and renderer RPCs, keeping the outbox lock and proxy shared.
  MemoryServiceLive,
  OrchestrationService.Default,
  ReviewService.Default,
  ContextManager.Default
)

// Later `Layer.provide`s satisfy the requirements of earlier ones, so the leaf
// dependencies (paths, dialog, Node platform) come last.
const RpcServicesLayer = RpcServerLive.pipe(
  // provideMerge: the RPC handlers consume DiscoveryService AND the main process
  // reaches the same instance to warm the model cache at startup (index.ts).
  Layer.provideMerge(DiscoveryService.Default),
  // AuthService requires SecretStore, satisfied by SecretStoreLive (merged below).
  Layer.provide(AuthService.Default),
  // Merged into one stage to stay inside `pipe`'s 20-argument limit. Neither
  // depends on the other — both are leaf FS/git consumers — so the composition
  // is unchanged by pairing them.
  Layer.provide(Layer.mergeAll(WorkspaceService.Default, AssetService.Default)),
  // Before SessionStore so the stores below satisfy the daemon's requirements —
  // a stage is provided-to by everything that follows it.
  // Merged so startup recovery can mark interrupted canonical plan revisions
  // stale through the same store instances the RPC handlers use.
  Layer.provideMerge(SessionStore.Default),
  Layer.provideMerge(StoreLayers),
  Layer.provide(HarnessLayers),
  // provideMerge (not provide): both app-lifetime services must stay in runtime
  // context. TerminalService is reached by the before-quit PTY reap; the browser
  // MCP service owns its scoped loopback listener and will be reached by the
  // harness injection stage. They are independent peers, merged to remain inside
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

const AppLayer = RpcServicesLayer.pipe(
  // Merged into one stage purely to stay inside `pipe`'s 20-argument limit;
  // neither depends on the other, so the composition is unchanged.
  Layer.provide(
    Layer.mergeAll(
      SkillsService.Default,
      OpenConnectorService.Default,
      OpenConnectorApi.Default
    )
  ),
  // provideMerge: the `Models.*` handlers consume ModelsService AND the startup
  // prefetch reaches the very same instance — a different one would warm a cache
  // nobody reads, so the merge is what makes the prefetch actually count. The
  // PluginHost joins this group for two reasons. It needs provideMerge — main
  // installs the Electron-backed process factory into it at startup, so the RPC
  // handlers must later reach the SAME instance rather than a second one with
  // no way to spawn. And `.pipe` tops out at 20 arguments, which a separate
  // stage would have exceeded; all three are peers with no dependencies, so
  // merging changes nothing but the argument count.
  Layer.provideMerge(
    Layer.mergeAll(
      ModelsService.Default,
      PluginHost.Default,
      // provideMerge for the same reason as PluginHost: main installs the
      // native consent prompt and the built-in github provider into it at
      // startup, so the RPC handlers must reach that same instance.
      PluginAuth.Default,
      // And PluginRegistry, because the host's consent flow looks a plugin's
      // display name up from the catalog before prompting — the operator picked
      // it by name in Settings, so the prompt has to say the name.
      PluginRegistry.Default
    )
  ),
  Layer.provide(UsageService.Default),
  Layer.provide(GhService.Default),
  // provideMerge: the `Config.*` handlers consume ConfigService AND the boot
  // theme resolution reads the active theme id from it before any window
  // exists.
  Layer.provideMerge(ConfigService.Default),
  Layer.provide(GitService.Default),
  Layer.provide(HarnessCliAdapterLive),
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
  // NodeContext bundles CommandExecutor + FileSystem + Path used by the git/gh/
  // discovery/config/workspace/session services. Merged (not just provided) so
  // the startup prefetch can run `DiscoveryService.list`, which needs the executor.
  Layer.provideMerge(NodeContext.layer)
)

export const runtime = ManagedRuntime.make(AppLayer)
