import type { AuthKind, ProviderConnectionId } from "@jingler/core"
import { Data, Effect } from "effect"

export class ProviderCredentialStoreError extends Data.TaggedError(
  "ProviderCredentialStoreError"
)<{ readonly message: string; readonly cause?: unknown }> {}

export interface StoredProviderCredential {
  readonly connectionId: ProviderConnectionId
  readonly authKind: AuthKind
  readonly access: string
  readonly refresh: string | null
  readonly expiresAt: number | null
}

export interface ProviderCredentialStore {
  readonly read: (
    connectionId: ProviderConnectionId
  ) => Effect.Effect<StoredProviderCredential | null, ProviderCredentialStoreError>
  readonly write: (
    credential: StoredProviderCredential
  ) => Effect.Effect<void, ProviderCredentialStoreError>
  readonly delete: (
    connectionId: ProviderConnectionId
  ) => Effect.Effect<void, ProviderCredentialStoreError>
}

export class InMemoryProviderCredentialStore implements ProviderCredentialStore {
  readonly #credentials = new Map<ProviderConnectionId, StoredProviderCredential>()

  read = (connectionId: ProviderConnectionId) =>
    Effect.sync(() => this.#credentials.get(connectionId) ?? null)

  write = (credential: StoredProviderCredential) =>
    Effect.sync(() => {
      this.#credentials.set(credential.connectionId, credential)
    })

  delete = (connectionId: ProviderConnectionId) =>
    Effect.sync(() => {
      this.#credentials.delete(connectionId)
    })
}
