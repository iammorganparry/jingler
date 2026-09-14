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
  /** Target-local MCP header/environment values encrypted in the same device vault. */
  readonly managedMcpSecrets?: Readonly<Record<string, unknown>>
  /** Operator MCP API keys and OAuth state, encrypted and keyed by server name. */
  readonly mcpCredentials?: Readonly<Record<string, unknown>>
  /** EXA/Firecrawl keys encrypted in the same vault; never exposed to renderer reads. */
  readonly webSearchCredentials?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}

// Effect's application graph can materialize more than one SecretStore service
// over the same encrypted device file. Serializing by service identity therefore
// permits a stale read from one service to overwrite another service's update.
// One process-wide queue protects the single device document across every
// environment, remote-session, provider, and managed-resource writer.
let serialQueue: Promise<unknown> = Promise.resolve()

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

const serial = <A>(operation: () => Promise<A>): Promise<A> => {
  const pending = serialQueue.then(operation, operation)
  serialQueue = pending.catch(() => undefined)
  return pending
}

export const readDeviceSecretDocument = (
  store: SecretStoreShape
): Promise<DeviceSecretDocument> =>
  serial(async () => decode(await Effect.runPromise(store.getDeviceSecrets)))

export const updateDeviceSecretDocument = (
  store: SecretStoreShape,
  update: (document: DeviceSecretDocument) => DeviceSecretDocument
): Promise<DeviceSecretDocument> =>
  serial(async () => {
    const document = decode(await Effect.runPromise(store.getDeviceSecrets))
    const next = update(document)
    if (next !== document) {
      await Effect.runPromise(store.setDeviceSecrets(JSON.stringify(next)))
    }
    return next
  })
