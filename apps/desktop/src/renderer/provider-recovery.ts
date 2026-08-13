import type { Environment, ProviderCatalog, Session } from "@jingler/core"

export interface ProviderRecovery {
  readonly title: string
  readonly message: string
}

export const providerRecoveryOf = (
  catalog: ProviderCatalog,
  selection: {
    connectionId: Session["connectionId"] | null
    modelId: Session["modelId"] | null
    connectionSelectionRequired?: boolean
    modelSelectionRequired?: boolean
    targetId: string
    target?: Environment
  }
): ProviderRecovery | undefined => {
  if (selection.connectionSelectionRequired || selection.modelSelectionRequired) {
    return {
      title: "Choose a runtime connection",
      message: "This migrated conversation is readable, but needs a certified connection and model before it can continue."
    }
  }
  if (selection.connectionId == null || selection.modelId == null) {
    return {
      title: "Runtime connection required",
      message: "Choose a certified provider connection and model to continue."
    }
  }
  const connection = catalog.connections.find(
    (candidate) => candidate.connection.id === selection.connectionId
  )
  if (connection === undefined) {
    return {
      title: "Provider connection unavailable",
      message: "Reconnect this account or choose another certified connection."
    }
  }
  const targetConnection = selection.target?.capabilities.providerConnections?.find(
    (candidate) => candidate.id === selection.connectionId
  )
  if (
    connection.connection.targetId !== selection.targetId &&
    selection.target?.kind !== "managed" &&
    targetConnection?.status !== "authenticated"
  ) {
    return {
      title: "Connection unavailable on this device",
      message: "Connect the same provider account on the selected execution device, or move the session to a compatible target."
    }
  }
  if (connection.connection.status !== "authenticated") {
    const reauthenticate = ["expired", "revoked", "reauthentication-required"].includes(
      connection.connection.status
    )
    return {
      title: reauthenticate ? "Provider authentication expired" : "Provider entitlement unavailable",
      message: reauthenticate
        ? "Reconnect the pinned billing route before continuing. Jingler will not fall back to another credential."
        : "Refresh this connection and confirm its subscription or API entitlement before continuing."
    }
  }
  const model = connection.models.find((candidate) => candidate.id === selection.modelId)
  if (model?.selectable === true) return undefined
  return {
    title: model?.verification === "stale" ? "Model certification is stale" : "Model unavailable",
    message: model?.verification === "stale"
      ? "Reverify this exact model and authentication route, or choose another certified model."
      : "Choose a model certified for this connection and execution target."
  }
}
