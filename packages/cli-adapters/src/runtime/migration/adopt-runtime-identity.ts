import type {
  Chat,
  ProviderCatalog,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
  Session
} from "@jingler/core"

/**
 * Automatic runtime-identity adoption for migrated sessions.
 *
 * The legacy→PI migration marked chats it could not resolve with
 * `connectionSelectionRequired` / `modelSelectionRequired`, and the renderer
 * blocks those conversations behind a "choose a runtime connection" banner.
 * That gate made sense when no connection could be resolved — but once the
 * operator HAS an authenticated connection for the same provider, asking them
 * to pick it by hand is pure ceremony. This resolves each gated chat to a
 * concrete connection + model so the conversation continues as if the
 * migration never happened.
 *
 * Deliberately scoped to MIGRATED identity gaps only (the explicit flags, or
 * legacy markers with missing ids) — a freshly created chat is never touched.
 */
export interface AdoptedChatIdentity {
  readonly chatId: string
  readonly connectionId: ProviderConnectionId
  readonly providerId: ProviderId
  readonly modelId: ProviderModelId
}

const needsAdoption = (chat: Chat): boolean =>
  chat.connectionSelectionRequired === true ||
  chat.modelSelectionRequired === true ||
  ((chat.legacyModel !== undefined || chat.legacyResumeId !== undefined) &&
    (chat.connectionId === undefined || chat.modelId === undefined))

/** Whether a session carries any migrated identity gap still waiting on adoption. */
export const sessionNeedsRuntimeIdentity = (session: Session): boolean =>
  session.connectionSelectionRequired === true ||
  session.modelSelectionRequired === true ||
  session.chats.some(needsAdoption)

const adoptFor = (
  chat: Chat,
  session: Session,
  catalog: ProviderCatalog,
  defaults: {
    readonly connectionId?: ProviderConnectionId | null
    readonly modelId?: ProviderModelId | null
  }
): AdoptedChatIdentity | null => {
  const authenticated = catalog.connections.filter(
    ({ connection }) => connection.status === "authenticated"
  )
  const targetProvider = chat.providerId ?? session.providerId ?? null
  // The connection: same provider first, then the configured default, then
  // any authenticated connection — a working runtime beats a matching brand.
  const candidate =
    authenticated.find(
      ({ connection }) =>
        targetProvider !== null && connection.providerId === targetProvider
    ) ??
    authenticated.find(
      ({ connection }) => connection.id === defaults.connectionId
    ) ??
    authenticated[0] ??
    null
  if (candidate === null) return null
  const models = candidate.models.filter((model) => model.selectable)
  if (models.length === 0) return null
  // The model: the chat's own legacy model when the connection still offers
  // it, then the configured default, then the connection's first model.
  const legacy =
    chat.legacyModel === undefined
      ? null
      : models.find(
          (model) =>
            model.id === `${candidate.connection.providerId}/${chat.legacyModel}`
        ) ?? null
  const configured =
    models.find((model) => model.id === defaults.modelId) ?? null
  const model = legacy ?? configured ?? models[0]!
  return {
    chatId: chat.id,
    connectionId: candidate.connection.id,
    providerId: model.providerId,
    modelId: model.id
  }
}

/** Every gated chat this session can adopt an identity for right now. */
export const adoptableChatIdentities = (
  session: Session,
  catalog: ProviderCatalog,
  defaults: {
    readonly connectionId?: ProviderConnectionId | null
    readonly modelId?: ProviderModelId | null
  }
): ReadonlyArray<AdoptedChatIdentity> => {
  const adoptions = session.chats.flatMap((chat) => {
    if (!needsAdoption(chat)) return []
    const adopted = adoptFor(chat, session, catalog, defaults)
    return adopted === null ? [] : [adopted]
  })
  if (adoptions.length > 0) return adoptions
  // Session-level flags can outlive healthy chats (the migration stamped both
  // levels independently). Re-affirming the active chat's identity through the
  // normal setter clears the session-level gate without changing anything.
  if (
    session.connectionSelectionRequired === true ||
    session.modelSelectionRequired === true
  ) {
    const active =
      session.chats.find((chat) => chat.id === session.activeChatId) ??
      session.chats[0] ??
      null
    if (active === null) return []
    if (
      active.connectionId !== undefined &&
      active.providerId !== undefined &&
      active.modelId !== undefined
    ) {
      return [{
        chatId: active.id,
        connectionId: active.connectionId,
        providerId: active.providerId,
        modelId: active.modelId
      }]
    }
    const adopted = adoptFor(active, session, catalog, defaults)
    return adopted === null ? [] : [adopted]
  }
  return adoptions
}
