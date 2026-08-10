import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { AppPaths } from "../../app-paths.js"
import { SecretStore } from "../../secret-store.js"
import { AgentSecretStore } from "../auth/agent-secret-store.js"
import { FileChangeTracker } from "../file-changes/file-change-tracker.js"
import { RunJournal } from "../journal/run-journal.js"
import { ProviderConnections } from "../providers/provider-connections.js"
import { ImportedMcpService } from "../resources/imported-mcp-service.js"
import { createMutationObserver } from "../tools/mutation-observer.js"
import { makeWorkspaceInspectionPort } from "../tools/workspace-tools.js"
import { AgentRuntime, AgentRuntimeError } from "./agent-runtime.js"
import { makePiAgentRuntime } from "./pi-agent-runtime.js"
import { createJinglerTools } from "./pi-jingler-tools.js"
import { makePiSessionFactory } from "./pi-session-factory.js"

const connectionFailure = (message: string, cause?: unknown) =>
  new AgentRuntimeError({ reason: "authentication", message, cause })

/** Production composition for the embedded pi runtime and Jingler-owned tools. */
export const PiAgentRuntimeLive = Layer.effect(
  AgentRuntime,
  Effect.gen(function* () {
    const paths = yield* AppPaths
    const secretStore = yield* SecretStore
    const providers = yield* ProviderConnections
    const importedMcp = yield* ImportedMcpService
    const workspace = yield* makeWorkspaceInspectionPort
    const credentials = new AgentSecretStore(secretStore)
    const runIds = new WeakMap<FileChangeTracker, string>()

    const factory = makePiSessionFactory({
      agentDir: paths.managedResourcesDir,
      sessionsDir: paths.piSessionsDir,
      credentials,
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
                message: "Provider connection is unavailable on this execution target"
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
      terminalTracker: (spec) => {
        const runId = randomUUID()
        const tracker = new FileChangeTracker({
          artifactDir: join(paths.runJournalsDir, "artifacts", runId),
          sessionId: spec.piSessionId ?? runId
        })
        runIds.set(tracker, runId)
        return tracker
      },
      createToolRegistry: (spec, context, tracker) => {
        if (!tracker) {
          return Effect.fail(
            new AgentRuntimeError({
              reason: "runtime",
              message: "The pi runtime requires workspace reconciliation"
            })
          )
        }
        const runId = runIds.get(tracker)
        if (!runId) {
          return Effect.fail(
            new AgentRuntimeError({
              reason: "runtime",
              message: "The pi runtime lost its run-scoped tracker"
            })
          )
        }
        return importedMcp.resolveForTarget(spec.targetCapabilities.targetId).pipe(
          Effect.mapError((cause) =>
            new AgentRuntimeError({
              reason: "runtime",
              message: cause.message,
              cause
            })
          ),
          Effect.flatMap((managedMcp) => createJinglerTools({
            context,
            cwd: spec.cwd,
            workspace,
            mcp: {
              imported: managedMcp.map((server) =>
                server.transport === "stdio"
                  ? { ...server, cwd: spec.cwd }
                  : server
              )
            },
            registryOptions: {
              observer: createMutationObserver({
                cwd: spec.cwd,
                runId,
                tracker,
                journal: new RunJournal({
                  file: join(paths.runJournalsDir, `${runId}.json`)
                })
              })
            }
          })),
          Effect.mapError((cause) =>
            new AgentRuntimeError({
              reason: "runtime",
              message: cause.message,
              cause
            })
          )
        )
      }
    })

    return yield* makePiAgentRuntime(factory)
  })
)
