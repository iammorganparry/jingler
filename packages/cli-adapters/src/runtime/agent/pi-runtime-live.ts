import { join } from "node:path"
import type { PiRunSpec } from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Layer, Option } from "effect"
import { AppPaths } from "../../app-paths.js"
import { ConfigService } from "../../config.js"
import { EnvironmentService } from "../../environment.js"
import { SecretStore } from "../../secret-store.js"
import { MemoryAttachmentService } from "../../memory-session.js"
import { PluginHost } from "../../plugin-host.js"
import { PluginRegistry } from "../../plugins.js"
import { SessionStore } from "../../sessions.js"
import { makeOffloadCommandRouterWithOwnedDevice } from "../../offload-command-router.js"
import { makeOwnedDeviceOffloadPort } from "../../owned-device-offload.js"
import { RemoteSessionService } from "../../remote-session.js"
import { AgentSecretStore } from "../auth/agent-secret-store.js"
import { RuntimeDiagnostics } from "../diagnostics/runtime-diagnostics.js"
import { FileChangeTracker } from "../file-changes/file-change-tracker.js"
import { RunJournal } from "../journal/run-journal.js"
import { BrowserControlPort } from "../../browser-control-port.js"
import {
  browserWebSearchPort,
  WebSearchService,
  withWebSearchFallback
} from "../../web-search.js"
import { ProviderConnections } from "../providers/provider-connections.js"
import { AgentResourceService } from "../resources/agent-resource-service.js"
import { ImportedMcpService } from "../resources/imported-mcp-service.js"
import { registerManagedFileTools } from "../resources/managed-file-tools.js"
import { createMutationObserver } from "../tools/mutation-observer.js"
import {
  enabledPluginAgentToolsets,
  persistPluginIssueReferences,
  registerPluginAgentTools
} from "../tools/plugin-agent-tools.js"
import type {
  PluginToolOrigin,
  ToolRegistry,
  ToolSuccessfulResult
} from "../tools/tool-registry.js"
import { makeToolMemory } from "../tools/tool-memory.js"
import { makeWorkspaceInspectionPort } from "../tools/workspace-tools.js"
import {
  makeWorkspaceMutationPort,
  registerWorkspaceMutationTools
} from "../tools/workspace-mutation-tools.js"
import { AgentRuntime, AgentRuntimeError } from "./agent-runtime.js"
import type { AgentRuntimeContext } from "./agent-runtime.js"
import { makePiAgentRuntime } from "./pi-agent-runtime.js"
import { createJinglerTools } from "./pi-jingler-tools.js"
import { makePiSessionFactory } from "./pi-session-factory.js"
import { PiChildCredentials } from "../subagents/pi-child-credentials.js"
import { makeSubagentCapabilityBroker } from "../subagents/subagent-capability-broker.js"
import type { PiSessionFactoryOptions } from "./pi-session-factory.js"

const connectionFailure = (message: string, cause?: unknown) =>
  new AgentRuntimeError({ reason: "authentication", message, cause })

export interface PluginToolSuccessfulResult
  extends Omit<ToolSuccessfulResult, "origin"> {
  readonly origin: PluginToolOrigin
  readonly sessionId: string
  readonly repository: {
    readonly name: string
    readonly path: string
  }
}

export interface PiAgentRuntimeLiveOptions {
  /** Settled bounded plugin-tool values; failures never alter the agent result. */
  readonly onPluginToolSuccessfulResult?: (
    result: PluginToolSuccessfulResult
  ) => void | Promise<void>
  /** Explicit test transport seam. Production must leave this unset. */
  readonly configureModelRuntime?: PiSessionFactoryOptions["configureModelRuntime"]
  /** Explicit test tool seam. Production must leave this unset. */
  readonly configureToolRegistry?: (input: {
    readonly registry: ToolRegistry
    readonly spec: PiRunSpec
    readonly context: AgentRuntimeContext
  }) => Effect.Effect<void>
}

/** Composition for the embedded pi runtime and Jingler-owned tools. */
export const makePiAgentRuntimeLive = (
  options: PiAgentRuntimeLiveOptions = {}
) => Layer.scoped(
  AgentRuntime,
  Effect.gen(function* () {
    const paths = yield* AppPaths
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* ConfigService
    const secretStore = yield* SecretStore
    const providers = yield* ProviderConnections
    const importedMcp = yield* ImportedMcpService
    const managedResources = yield* AgentResourceService
    const diagnostics = yield* RuntimeDiagnostics
    const pluginRegistry = yield* PluginRegistry
    const pluginHost = yield* PluginHost
    const sessionStore = yield* SessionStore
    const memory = yield* Effect.serviceOption(MemoryAttachmentService)
    const workspace = yield* makeWorkspaceInspectionPort
    const webSearch = yield* Effect.serviceOption(WebSearchService)
    const browserControl = yield* Effect.serviceOption(BrowserControlPort)
    const mutations = yield* makeWorkspaceMutationPort
    const remoteSessions = yield* Effect.serviceOption(RemoteSessionService)
    const environments = yield* Effect.serviceOption(EnvironmentService)
    const offload = yield* makeOffloadCommandRouterWithOwnedDevice(
      Option.isSome(remoteSessions) && Option.isSome(environments)
        ? makeOwnedDeviceOffloadPort(
            remoteSessions.value,
            (deviceId) => Effect.gen(function* () {
              for (let attempt = 0; attempt < 3; attempt += 1) {
                const inventory = yield* environments.value.list
                if (inventory.some((environment) =>
                  environment.id === deviceId &&
                  environment.kind === "owned" &&
                  environment.state === "online"
                )) return true
                if (attempt < 2) yield* Effect.sleep(250)
              }
              return false
            })
          )
        : undefined
    )
    const credentials = new AgentSecretStore(secretStore)
    const subagentBroker = yield* Effect.acquireRelease(
      makeSubagentCapabilityBroker(),
      (broker) => broker.close
    )
    const childCredentials = new PiChildCredentials(
      join(paths.managedResourcesDir, "subagent-credentials"),
      credentials
    )
    yield* childCredentials.clear().pipe(
      Effect.mapError((cause) =>
        new AgentRuntimeError({
          reason: "runtime",
          message: cause.message,
          cause
        })
      )
    )

    const factory = makePiSessionFactory({
      agentDir: paths.managedResourcesDir,
      sessionsDir: paths.piSessionsDir,
      credentials,
      childCredentials,
      subagentBroker,
      resolveConnection: (spec) =>
        Effect.gen(function* () {
          const connections = yield* providers.status.pipe(
            Effect.mapError((cause) =>
              connectionFailure("Could not read provider connections", cause)
            )
          )
          const connection = connections.find(
            (candidate) => candidate.id === spec.connectionId
          )
          if (connection === undefined) {
            return yield* Effect.fail(
              connectionFailure("Provider connection not found")
            )
          }
          if (connection.status !== "authenticated") {
            return yield* Effect.fail(
              connectionFailure("Provider connection requires authentication")
            )
          }
          if (connection.targetId !== spec.targetCapabilities.targetId) {
            return yield* Effect.fail(
              new AgentRuntimeError({
                reason: "incompatible-target",
                message:
                  `Provider connection targets ${connection.targetId}, ` +
                  `but this run targets ${spec.targetCapabilities.targetId}`
              })
            )
          }
          const catalog = yield* providers.list.pipe(
            Effect.mapError((cause) =>
              new AgentRuntimeError({
                reason: "certification",
                message: "Could not verify model certification",
                cause
              })
            )
          )
          const model = catalog.connections
            .find((entry) => entry.connection.id === connection.id)
            ?.models.find((candidate) => candidate.id === spec.modelId)
          if (model?.selectable !== true) {
            return yield* Effect.fail(
              new AgentRuntimeError({
                reason: "certification",
                message: "The selected model is not available on this connection"
              })
            )
          }
          return connection
        }),
      terminalTracker: (spec) => new FileChangeTracker({
        artifactDir: join(paths.runJournalsDir, "artifacts", spec.runId),
        sessionId: spec.piSessionId ?? spec.runId
      }),
      createToolRegistry: (spec, context, tracker) => {
        Effect.runFork(
          offload.primeSession(spec.cwd, spec.sessionId).pipe(Effect.ignore)
        )
        const runWebSearch = Option.isSome(webSearch)
          ? Option.isSome(browserControl) && context.mcp?.browser != null
            ? withWebSearchFallback(
                webSearch.value,
                browserWebSearchPort(browserControl.value.forSession(spec.sessionId))
              )
            : webSearch.value
          : undefined
        const pluginSetup = Effect.all({
          catalog: pluginRegistry.list().pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(AppPaths, paths),
            Effect.provideService(ConfigService, config)
          ),
          host: pluginHost.get(),
          session: sessionStore.get(spec.sessionId).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(AppPaths, paths)
          )
        }).pipe(
          Effect.map(({ catalog, host, session }) => ({
            host,
            sources: enabledPluginAgentToolsets(catalog.plugins),
            context: {
              id: session.id,
              repository: { name: session.repo, path: spec.cwd }
            }
          })),
          // Plugin tools are additive. A missing/dead host must not remove
          // Jingler's built-in tools from an otherwise healthy run.
          Effect.orElseSucceed(() => null)
        )
        if (!tracker) {
          return Effect.fail(
            new AgentRuntimeError({
              reason: "runtime",
              message: "The pi runtime requires workspace reconciliation"
            })
          )
        }
        return Effect.all({
          managedMcp: importedMcp.resolveForTarget(spec.targetCapabilities.targetId),
          managedFiles: managedResources.enabledForTarget(spec.targetCapabilities.targetId),
          plugins: pluginSetup
        }).pipe(
          Effect.mapError((cause) =>
            new AgentRuntimeError({
              reason: "runtime",
              message: cause.message,
              cause
            })
          ),
          Effect.flatMap(({ managedMcp, managedFiles, plugins }) => createJinglerTools({
            context,
            cwd: spec.cwd,
            workspace,
            ...(runWebSearch === undefined ? {} : { webSearch: runWebSearch }),
            mcp: {
              ...context.mcp,
              imported: managedMcp.map((server) =>
                server.transport === "stdio"
                  ? { ...server, cwd: spec.cwd }
                  : server
              )
            },
            // Per-run attachments (the browser lease rotates every turn on a
            // retained session) resolve from the LIVE context at call time.
            // Imported managed servers keep their registration-time config —
            // the cwd-adjusted mapping above — so they are excluded here.
            liveMcp: () => {
              const current = context.mcp
              return current === undefined
                ? undefined
                : { ...current, imported: undefined }
            },
            registryOptions: {
              ...(Option.isSome(memory)
                ? { memory: makeToolMemory({ memory: memory.value, runId: spec.runId }) }
                : {}),
              ...(plugins
                ? {
                    onSuccessfulResult: async (result: ToolSuccessfulResult) => {
                      if (result.origin?.kind !== "plugin") return
                      const linked = await persistPluginIssueReferences(
                        result.origin,
                        result.value,
                        spec.prompt,
                        (issues) => Effect.runPromise(
                          sessionStore.addIssues(plugins.context.id, issues).pipe(
                            Effect.provideService(FileSystem.FileSystem, fs),
                            Effect.provideService(AppPaths, paths)
                          )
                        )
                      )
                      if (linked) {
                        await Effect.runPromise(
                          context.publishEvent({ _tag: "SessionIssueLinksChanged" })
                        )
                      }
                      await options.onPluginToolSuccessfulResult?.({
                        ...result,
                        origin: result.origin,
                        sessionId: plugins.context.id,
                        repository: plugins.context.repository
                      })
                    }
                  }
                : {}),
              observer: createMutationObserver({
                cwd: spec.cwd,
                runId: spec.runId,
                sessionId: spec.sessionId,
                chatId: spec.chatId,
                tracker,
                journal: new RunJournal({
                  file: join(paths.runJournalsDir, `${spec.runId}.json`)
                })
              })
            }
          }).pipe(
            Effect.tap((registry) => Effect.sync(() =>
              registerManagedFileTools(registry, managedResources, managedFiles)
            )),
            Effect.tap((registry) => Effect.sync(() =>
              registerWorkspaceMutationTools(registry, spec.cwd, mutations, {
                sessionId: spec.sessionId,
                offload
              })
            )),
            Effect.tap((registry) =>
              plugins === null
                ? Effect.void
                : Effect.promise(() =>
                    registerPluginAgentTools(
                      registry,
                      plugins.host,
                      plugins.sources,
                      plugins.context
                    )
                  ).pipe(Effect.asVoid)
            ),
            Effect.tap((registry) =>
              options.configureToolRegistry?.({ registry, spec, context }) ?? Effect.void
            )
          )),
          Effect.mapError((cause) =>
            new AgentRuntimeError({
              reason: "runtime",
              message: cause.message,
              cause
            })
          )
        )
      },
      recordDiagnostic: diagnostics.record,
      ...(options.configureModelRuntime
        ? { configureModelRuntime: options.configureModelRuntime }
        : {})
    })

    return yield* makePiAgentRuntime(factory)
  })
)

/** Production composition: no alternate provider transport is installed. */
export const PiAgentRuntimeLive = makePiAgentRuntimeLive()
