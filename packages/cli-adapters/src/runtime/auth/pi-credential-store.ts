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

const toPiCredentialValue = (
  credential: StoredProviderCredential
): Credential =>
  credential.authKind === "openai-codex-oauth" ||
  credential.authKind === "claude-setup-token"
    ? {
        type: "oauth",
        access: credential.access,
        refresh: credential.refresh ?? "",
        // Claude CLI connections carry only a non-secret route marker. Pi still
        // needs an OAuth-shaped credential to select the provider; the CLI relay
        // owns authentication and never sends this value upstream.
        expires: credential.expiresAt ?? Number.MAX_SAFE_INTEGER
      }
    : { type: "api_key", key: credential.access }

export const toPiCredential = (
  connection: ProviderConnection,
  credential: StoredProviderCredential
): Credential => {
  if (credential.authKind !== connection.authKind) {
    throw new Error("Reauthentication required")
  }
  if (
    connection.authKind === "claude-setup-token" && (
      credential.access !== "claude-cli" ||
      connection.subscription.observedRoute !== "claude-cli:subscription"
    )
  ) throw new Error("Reauthentication required")
  return toPiCredentialValue(credential)
}

const fromPiCredential = (
  connection: ProviderConnection,
  credential: Credential
): StoredProviderCredential =>
  credential.type === "oauth"
    ? connection.authKind === "claude-setup-token"
      ? {
          connectionId: connection.id,
          authKind: connection.authKind,
          access: credential.access,
          refresh: null,
          expiresAt: null
        }
      : {
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
      return credential === null
        ? undefined
        : toPiCredential(connection, credential)
    },
    list: async (): Promise<ReadonlyArray<CredentialInfo>> => {
      const credential = await Effect.runPromise(credentials.read(connection.id))
      if (credential === null) return []
      return [{
        providerId: connection.providerId,
        type: toPiCredential(connection, credential).type
      }]
    },
    modify: (providerId, change) =>
      serial(async () => {
        if (providerId !== connection.providerId) return 
        const current = await Effect.runPromise(credentials.read(connection.id))
        const next = await change(
          current === null
            ? undefined
            : toPiCredential(connection, current)
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
