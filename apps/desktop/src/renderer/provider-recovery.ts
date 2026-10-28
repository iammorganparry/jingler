import type { Environment, ProviderCatalog, ProviderConnectionId, ProviderId, Session } from "@jingler/core"

export interface ProviderRecovery {
  readonly title: string
  readonly message: string
  /** `signed-out` cards offer Reconnect in place; the rest open provider settings. */
  readonly kind?: "signed-out"
  readonly connectionId?: ProviderConnectionId
  readonly providerId?: ProviderId
}

const PROVIDER_NAMES: Record<string, string> = { claude: "Claude Code", "openai-codex": "ChatGPT Codex" }

const connectionStatusRecovery = (
  entry: ProviderCatalog["connections"][number]
): ProviderRecovery => {
  const { status, providerId, id } = entry.connection
  const reauthenticate = ["expired", "revoked", "reauthentication-required"].includes(
    status
  )
  if (reauthenticate) {
    return {
      kind: "signed-out",
      connectionId: id,
      providerId,
      title: `${PROVIDER_NAMES[providerId] ?? providerId} signed out during this run`,
      message: "Reconnect to continue. A subscription never falls back to an API key."
    }
  }
  return {
    title: reauthenticate ? "Provider authentication expired" : "Provider entitlement unavailable",
    message: reauthenticate
      ? "Reconnect the pinned billing route before continuing. Jingler will not fall back to another credential."
      : "Refresh this connection and confirm its subscription or API entitlement before continuing."
  }
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
    return connectionStatusRecovery(connection)
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

/**
 * A deleted-then-reconnected provider account comes back under a NEW connection
 * id, so a session pinned to the old id shows "Provider connection unavailable"
 * forever — reconnecting never restores the id it is waiting for. When the
 * pinned connection is gone and the catalog holds exactly ONE connection for
 * the same provider that would pass every recovery check with the session's
 * model, that connection is the unambiguous replacement to rebind to. Zero or
 * several candidates resolve to undefined: the operator chooses explicitly.
 */
export const providerRebindOf = (
  catalog: ProviderCatalog,
  selection: {
    connectionId: Session["connectionId"] | null
    providerId: Session["providerId"] | null
    modelId: Session["modelId"] | null
    connectionSelectionRequired?: boolean
    modelSelectionRequired?: boolean
    targetId: string
    target?: Environment
  }
): ProviderConnectionId | undefined => {
  const candidates = providerRebindCandidatesOf(catalog, selection)
  return candidates.length === 1 ? candidates[0]?.id : undefined
}

/**
 * "Limited until HH:MM" when the pinned connection reports a usage limit. The
 * catalog has no structured reset time, so this reads the probe's
 * `rateLimitLabel` ("Limited until 16:40").
 */
export const providerLimitOf = (
  catalog: ProviderCatalog,
  connectionId: Session["connectionId"] | null
): string | undefined =>
  catalog.connections
    .find(({ connection }) => connection.id === connectionId)
    ?.connection.subscription.rateLimitLabel?.match(/^Limited until \S+/u)?.[0]

/** Signed-in accounts that could take over a gone pinned connection; never auto-picked when several. */
export const providerRebindCandidatesOf = (
  catalog: ProviderCatalog,
  selection: Parameters<typeof providerRebindOf>[1]
): ReadonlyArray<ProviderCatalog["connections"][number]["connection"]> => {
  if (selection.connectionSelectionRequired || selection.modelSelectionRequired) return []
  if (selection.connectionId == null || selection.providerId == null || selection.modelId == null)
    return []
  if (catalog.connections.some(({ connection }) => connection.id === selection.connectionId)) return []
  return catalog.connections
    .filter(
      ({ connection }) =>
        connection.providerId === selection.providerId &&
        providerRecoveryOf(catalog, { ...selection, connectionId: connection.id }) === undefined
    )
    .map(({ connection }) => connection)
}
