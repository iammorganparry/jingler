import type {
  Credential,
  CredentialInfo,
  CredentialStore
} from "@earendil-works/pi-ai"
import type { ProviderConnection } from "@jingler/core"
import { Effect } from "effect"
import type {
  ProviderCredentialStore,
  StoredProviderCredential
} from "./credential-store.js"

const toPiCredential = (
  credential: StoredProviderCredential
): Credential =>
  credential.authKind === "openai-codex-oauth"
    ? {
        type: "oauth",
        access: credential.access,
        refresh: credential.refresh ?? "",
        expires: credential.expiresAt ?? 0
      }
    : { type: "api_key", key: credential.access }

const fromPiCredential = (
  connection: ProviderConnection,
  credential: Credential
): StoredProviderCredential =>
  credential.type === "oauth"
    ? {
        connectionId: connection.id,
        authKind: "openai-codex-oauth",
        access: credential.access,
        refresh: credential.refresh,
        expiresAt: credential.expires
      }
    : {
        connectionId: connection.id,
        authKind: connection.authKind,
        access: credential.key ?? "",
        refresh: null,
        expiresAt: null
      }

/** A connection-pinned pi store: unrelated credentials and environment routes are invisible. */
export const makePiCredentialStore = (
  connection: ProviderConnection,
  credentials: ProviderCredentialStore
): CredentialStore => {
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <A>(operation: () => Promise<A>): Promise<A> => {
    const pending = queue.then(operation, operation)
    queue = pending.catch(() => undefined)
    return pending
  }
  return {
    read: async (providerId) => {
      if (providerId !== connection.providerId) return 
      const credential = await Effect.runPromise(credentials.read(connection.id))
      return credential === null ? undefined : toPiCredential(credential)
    },
    list: async (): Promise<ReadonlyArray<CredentialInfo>> => {
      const credential = await Effect.runPromise(credentials.read(connection.id))
      return credential === null
        ? []
        : [
            {
              providerId: connection.providerId,
              type:
                credential.authKind === "openai-codex-oauth"
                  ? "oauth"
                  : "api_key"
            }
          ]
    },
    modify: (providerId, change) =>
      serial(async () => {
        if (providerId !== connection.providerId) return 
        const current = await Effect.runPromise(credentials.read(connection.id))
        const next = await change(
          current === null ? undefined : toPiCredential(current)
        )
        if (next !== undefined) {
          await Effect.runPromise(
            credentials.write(fromPiCredential(connection, next))
          )
        }
        return next
      }),
    delete: (providerId) =>
      serial(async () => {
        if (providerId === connection.providerId) {
          await Effect.runPromise(credentials.delete(connection.id))
        }
      })
  }
}
