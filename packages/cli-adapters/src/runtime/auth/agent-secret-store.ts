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

const ManagedMcpSecretPayload = Schema.Struct({
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
  env: Schema.Record({ key: Schema.String, value: Schema.String })
})
export type ManagedMcpSecretPayload = Schema.Schema.Type<typeof ManagedMcpSecretPayload>

const mcpSecretKey = (resourceId: string, targetId: string): string =>
  `${encodeURIComponent(targetId)}:${encodeURIComponent(resourceId)}`

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

  readMcp = (resourceId: string, targetId: string) =>
    Effect.tryPromise({
      try: async () => {
        const document = await readDeviceSecretDocument(this.#store)
        const value = document.managedMcpSecrets?.[mcpSecretKey(resourceId, targetId)]
        const decoded = Schema.decodeUnknownEither(ManagedMcpSecretPayload)(value)
        return Either.isLeft(decoded) ? null : decoded.right
      },
      catch: (cause) => new CredentialStoreError({ message: "Failed to read MCP secrets", cause })
    })

  writeMcp = (resourceId: string, targetId: string, value: ManagedMcpSecretPayload) =>
    Effect.tryPromise({
      try: async () => {
        const payload = Schema.decodeUnknownSync(ManagedMcpSecretPayload)(value)
        await updateDeviceSecretDocument(this.#store, (document) => ({
          ...document,
          managedMcpSecrets: {
            ...document.managedMcpSecrets,
            [mcpSecretKey(resourceId, targetId)]: payload
          }
        }))
      },
      catch: (cause) => new CredentialStoreError({ message: "Failed to persist MCP secrets", cause })
    })

  deleteMcp = (resourceId: string, targetId: string) =>
    Effect.tryPromise({
      try: async () => {
        await updateDeviceSecretDocument(this.#store, (document) => {
          const secrets = { ...document.managedMcpSecrets }
          delete secrets[mcpSecretKey(resourceId, targetId)]
          return { ...document, managedMcpSecrets: secrets }
        })
      },
      catch: (cause) => new CredentialStoreError({ message: "Failed to delete MCP secrets", cause })
    })
}
