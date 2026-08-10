import {
  readDeviceSecretDocument,
  updateDeviceSecretDocument
} from "../../device-secret-document.js"
import type { SecretStoreShape } from "../../secret-store.js"
import type {
  ProviderCredentialStore,
  StoredProviderCredential
} from "./credential-store.js"
import { AuthKind } from "@jingler/core"
import { Effect, Either, Schema } from "effect"
import { ProviderCredentialStoreError as CredentialStoreError } from "./credential-store.js"

const StoredCredentialPayload = Schema.Struct({
  authKind: AuthKind,
  access: Schema.String,
  refresh: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number)
})

const decodeCredential = (
  connectionId: StoredProviderCredential["connectionId"],
  value: unknown
): StoredProviderCredential | null => {
  const decoded = Schema.decodeUnknownEither(StoredCredentialPayload)(value)
  return Either.isLeft(decoded)
    ? null
    : { connectionId, ...decoded.right }
}

/**
 * Stores agent credentials inside SecretStore's existing encrypted device document.
 * The renderer never receives this document; desktop production persistence is
 * encrypted by Electron safeStorage and tests can reuse the in-memory implementation.
 */
export class AgentSecretStore implements ProviderCredentialStore {
  readonly #store: SecretStoreShape

  constructor(store: SecretStoreShape) {
    this.#store = store
  }

  read = (connectionId: StoredProviderCredential["connectionId"]) =>
    Effect.tryPromise({
      try: async () => {
        const document = await readDeviceSecretDocument(this.#store)
        return decodeCredential(
          connectionId,
          document.agentCredentials?.[connectionId]
        )
      },
      catch: (cause) =>
        new CredentialStoreError({
          message: "Failed to read provider credential",
          cause
        })
    })

  write = (credential: StoredProviderCredential) =>
    Effect.tryPromise({
      try: async () => {
        await updateDeviceSecretDocument(this.#store, (document) => ({
          ...document,
          agentCredentials: {
            ...document.agentCredentials,
            [credential.connectionId]: {
              authKind: credential.authKind,
              access: credential.access,
              refresh: credential.refresh,
              expiresAt: credential.expiresAt
            }
          }
        }))
      },
      catch: (cause) =>
        new CredentialStoreError({
          message: "Failed to persist provider credential",
          cause
        })
    })

  delete = (connectionId: StoredProviderCredential["connectionId"]) =>
    Effect.tryPromise({
      try: async () => {
        await updateDeviceSecretDocument(this.#store, (document) => {
          const credentials = { ...document.agentCredentials }
          delete credentials[connectionId]
          return { ...document, agentCredentials: credentials }
        })
      },
      catch: (cause) =>
        new CredentialStoreError({
          message: "Failed to delete provider credential",
          cause
        })
    })
}
