import type { SecretStoreShape } from "./secret-store.js"
import { Effect } from "effect"

export interface DirectSshTarget {
  readonly host: string
  readonly username?: string
  readonly port?: number
}

export interface DeviceSecretDocument {
  readonly clientInstanceId?: string
  readonly remoteSessions?: Readonly<Record<string, unknown>>
  readonly remoteRequestNamespace?: string
  readonly directSshTargets?: Readonly<Record<string, DirectSshTarget>>
  /** Provider credentials encrypted inside the existing device-secret vault. */
  readonly agentCredentials?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}

const serialByStore = new WeakMap<SecretStoreShape, Promise<unknown>>()

const decode = (raw: string | null): DeviceSecretDocument => {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : {}
  } catch {
    return {}
  }
}

const serial = <A>(store: SecretStoreShape, operation: () => Promise<A>): Promise<A> => {
  const pending = (serialByStore.get(store) ?? Promise.resolve()).then(operation)
  serialByStore.set(store, pending.catch(() => undefined))
  return pending
}

export const readDeviceSecretDocument = (
  store: SecretStoreShape
): Promise<DeviceSecretDocument> =>
  serial(store, async () => decode(await Effect.runPromise(store.getDeviceSecrets)))

export const updateDeviceSecretDocument = (
  store: SecretStoreShape,
  update: (document: DeviceSecretDocument) => DeviceSecretDocument
): Promise<DeviceSecretDocument> =>
  serial(store, async () => {
    const document = decode(await Effect.runPromise(store.getDeviceSecrets))
    const next = update(document)
    if (next !== document) {
      await Effect.runPromise(store.setDeviceSecrets(JSON.stringify(next)))
    }
    return next
  })
