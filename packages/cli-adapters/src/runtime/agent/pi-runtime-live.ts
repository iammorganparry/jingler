import { join } from "node:path"
import type { PiRunSpec } from "@jingler/core"
import { Effect, Layer, Option } from "effect"
import { AppPaths } from "../../app-paths.js"
import { SecretStore } from "../../secret-store.js"
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
import type { ToolRegistry } from "../tools/tool-registry.js"
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
import type { PiSessionFactoryOptions } from "./pi-session-factory.js"

const connectionFailure = (message: string, cause?: unknown) =>
  new AgentRuntimeError({ reason: "authentication", message, cause })

export interface PiAgentRuntimeLiveOptions {
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
) => Layer.effect(
  AgentRuntime,
  Effect.gen(function* () {
    const paths = yield* AppPaths
    const secretStore = yield* SecretStore
    const providers = yield* ProviderConnections
    const importedMcp = yield* ImportedMcpService
    const managedResources = yield* AgentResourceService
    const diagnostics = yield* RuntimeDiagnostics
    const workspace = yield* makeWorkspaceInspectionPort
    const webSearch = yield* Effect.serviceOption(WebSearchService)
    const browserControl = yield* Effect.serviceOption(BrowserControlPort)
    const mutations = yield* makeWorkspaceMutationPort
    const credentials = new AgentSecretStore(secretStore)
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
                message: "The selected model is not certified for this connection"
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
        const runWebSearch = Option.isSome(webSearch)
          ? Option.isSome(browserControl) && context.mcp?.browser != null
            ? withWebSearchFallback(
                webSearch.value,
                browserWebSearchPort(browserControl.value.forSession(spec.sessionId))
              )
            : webSearch.value
          : undefined
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
          managedFiles: managedResources.enabledForTarget(spec.targetCapabilities.targetId)
        }).pipe(
          Effect.mapError((cause) =>
            new AgentRuntimeError({
              reason: "runtime",
              message: cause.message,
              cause
            })
          ),
          Effect.flatMap(({ managedMcp, managedFiles }) => createJinglerTools({
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
            registryOptions: {
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
              registerWorkspaceMutationTools(registry, spec.cwd, mutations)
            )),
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
