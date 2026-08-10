import {
  readDeviceSecretDocument,
  updateDeviceSecretDocument
} from "../../device-secret-document.js"
import type { SecretStoreShape } from "../../secret-store.js"
import type {
  ProviderCredentialStore,
  StoredProviderCredential
} from "./credential-store.js"
import { Effect } from "effect"
import { ProviderCredentialStoreError as CredentialStoreError } from "./credential-store.js"

const decodeCredential = (
  connectionId: StoredProviderCredential["connectionId"],
  value: unknown
): StoredProviderCredential | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const authKind = candidate.authKind
  const access = candidate.access
  const refresh = candidate.refresh
  const expiresAt = candidate.expiresAt

  if (
    (authKind !== "claude-setup-token" &&
      authKind !== "openai-codex-oauth" &&
      authKind !== "api-key" &&
      authKind !== "device-environment") ||
    typeof access !== "string" ||
    (refresh !== null && typeof refresh !== "string") ||
    (expiresAt !== null && typeof expiresAt !== "number")
  ) {
    return null
  }

  return { connectionId, authKind, access, refresh, expiresAt }
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
