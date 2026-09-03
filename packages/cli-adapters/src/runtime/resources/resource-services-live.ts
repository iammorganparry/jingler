import { Effect, Layer } from "effect"
import { AppPaths } from "../../app-paths.js"
import {
  AgentResourceService,
  makeAgentResourceService
} from "./agent-resource-service.js"

/** Shared app-lifetime resource services for desktop and device pi runtimes. */
export const AgentResourcesLive = Layer.effect(
  AgentResourceService,
  Effect.flatMap(AppPaths, (paths) =>
    makeAgentResourceService({ managedRoot: paths.managedResourcesDir })
  )
)
