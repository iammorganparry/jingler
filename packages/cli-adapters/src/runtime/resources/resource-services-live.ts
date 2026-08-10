import { Effect, Layer } from "effect"
import { AppPaths } from "../../app-paths.js"
import { SecretStore } from "../../secret-store.js"
import { AgentSecretStore } from "../auth/agent-secret-store.js"
import {
  AgentResourceService,
  makeAgentResourceService
} from "./agent-resource-service.js"
import {
  ImportedMcpService,
  makeImportedMcpService
} from "./imported-mcp-service.js"

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

/** Shared app-lifetime resource services for desktop and device pi runtimes. */
export const AgentResourcesLive = Layer.merge(FileResourcesLive, ImportedMcpLive)
