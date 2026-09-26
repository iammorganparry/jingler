import type { AgentEndpointCatalog, Environment, Session } from "@jingler/core"

export const runtimeTargetForSession = (session: Session, environments: ReadonlyArray<Environment>) => session.environmentId === undefined
  ? "desktop"
  : (environments.find(({ id }) => id === session.environmentId)?.capabilities.runtime?.targetId ?? session.environmentId)

export const endpointCatalogForSession = (session: Session, environments: ReadonlyArray<Environment>, catalog: AgentEndpointCatalog | null | undefined) => {
  if (catalog == null) return catalog
  const endpoints = catalog.endpoints.filter(({ endpoint }) => endpoint.targetId === runtimeTargetForSession(session, environments))
  const environment = environments.find(({ id }) => id === session.environmentId)
  return environment?.kind === "managed" && endpoints.length === 0 ? null : { ...catalog, endpoints }
}
