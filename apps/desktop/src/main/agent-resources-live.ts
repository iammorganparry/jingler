import {
  AgentResourceService,
  AgentSecretStore,
  AppPaths,
  ImportedMcpService,
  makeAgentResourceService,
  makeImportedMcpService,
  SecretStore
} from "@jingler/cli-adapters"
import { Effect, Layer } from "effect"

const FileResourcesLive = Layer.effect(
  AgentResourceService,
  Effect.flatMap(AppPaths, (paths) =>
    makeAgentResourceService({ managedRoot: paths.managedResourcesDir })
  )
)

const ImportedMcpLive = Layer.effect(
  ImportedMcpService,
  Effect.gen(function* () {
    const paths = yield* AppPaths
    const secretStore = yield* SecretStore
    return yield* makeImportedMcpService({
      metadataFile: paths.importedMcpFile,
      secrets: new AgentSecretStore(secretStore)
    })
  })
)

/** Shared app-lifetime resource services for runtime composition and typed RPC. */
export const AgentResourcesLive = Layer.merge(FileResourcesLive, ImportedMcpLive)
