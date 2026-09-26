import {
  type AgentEndpointCatalog,
  type AgentEndpointStatus,
  CURRENT_RUNTIME_CONTRACTS,
  piEndpointId,
  type ProviderCatalog,
  type ProviderConnection
} from "@jingler/core"

const endpointStatus = (connection: ProviderConnection): AgentEndpointStatus => {
  switch (connection.status) {
    case "authenticated":
      return "ready"
    case "disconnected":
    case "expired":
    case "revoked":
    case "reauthentication-required":
    case "entitlement-unconfirmed":
      return "signed-out"
    case "connecting":
      return "error"
  }
}

export const projectPiEndpointCatalog = (
  catalog: ProviderCatalog
): AgentEndpointCatalog => ({
  refreshedAt: catalog.refreshedAt,
  stale: catalog.stale,
  endpoints: catalog.connections.map(({ connection, models }) => {
    const status = endpointStatus(connection)
    return {
      endpoint: {
        id: piEndpointId(connection.targetId, connection.id),
        runtimeId: "pi",
        targetId: connection.targetId,
        label: `PI · ${connection.account?.displayLabel ?? connection.providerId}`,
        status,
        version: null,
        ...(CURRENT_RUNTIME_CONTRACTS.piSdk === undefined
          ? {}
          : { protocolVersion: CURRENT_RUNTIME_CONTRACTS.piSdk }),
        features: {
          steer: "text",
          planReview: true,
          subagentFleet: true,
          backgroundTasks: true
        }
      },
      models: models.map((model) => ({
        ...model,
        status: status === "ready" ? "ready" as const : "unavailable" as const,
        selectable: status === "ready" && model.selectable
      }))
    }
  })
})
