import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  SecretStore,
  SecretStoreUnavailable,
  type SecretStoreShape
} from "@jingler/cli-adapters/secret-store"
import { Effect, Layer } from "effect"
import { loadOrCreateDeviceIdentity } from "./device-identity.js"

const unavailable = (message: string) =>
  new SecretStoreUnavailable({ message })

const decodeDocument = (raw: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Malformed device secret document")
  }
  return Object.fromEntries(Object.entries(parsed))
}

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}

/** Persisted values win; environment credentials only seed missing connections. */
const mergeInitialDocument = (initial: string, persisted: string | null): string => {
  if (persisted === null) return JSON.stringify(decodeDocument(initial))
  const seed = decodeDocument(initial)
  const saved = decodeDocument(persisted)
  return JSON.stringify({
    ...seed,
    ...saved,
    agentCredentials: {
      ...record(seed.agentCredentials),
      ...record(saved.agentCredentials)
    },
    managedMcpSecrets: {
      ...record(seed.managedMcpSecrets),
      ...record(saved.managedMcpSecrets)
    }
  })
}

export const makeDeviceSecretStore = (
  identityFile: string,
  secretsFile: string,
  initialDeviceSecrets: string
): Effect.Effect<SecretStoreShape, SecretStoreUnavailable> =>
  Effect.gen(function* () {
    const identity = yield* loadOrCreateDeviceIdentity(identityFile).pipe(
      Effect.mapError(() => unavailable("Device identity is unavailable"))
    )
    const readStrict = Effect.tryPromise({
      try: async () => {
        try {
          const encrypted = await readFile(secretsFile)
          return Buffer.from(identity.unprotectSecret(encrypted)).toString("utf8")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
          throw error
        }
      },
      catch: () => unavailable("Failed to read encrypted device secrets")
    })
    const write = (value: string) =>
      Effect.tryPromise({
        try: async () => {
          const directory = dirname(secretsFile)
          await mkdir(directory, { recursive: true, mode: 0o700 })
          await chmod(directory, 0o700)
          const temporary = `${secretsFile}.${process.pid}.${randomUUID()}.next`
          const encrypted = identity.protectSecret(Buffer.from(value, "utf8"))
          await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" })
          try {
            await rename(temporary, secretsFile)
            await chmod(secretsFile, 0o600)
          } catch (error) {
            await rm(temporary, { force: true })
            throw error
          }
        },
        catch: () => unavailable("Failed to persist encrypted device secrets")
      })
    const persisted = yield* readStrict
    const initial = mergeInitialDocument(initialDeviceSecrets, persisted)
    if (persisted !== initial) yield* write(initial)
    return SecretStore.of({
      get: Effect.succeed(null),
      set: () => Effect.fail(unavailable("Device sign-in storage is unavailable")),
      clear: Effect.void,
      getOpenConnectorToken: Effect.succeed(null),
      setOpenConnectorToken: () =>
        Effect.fail(unavailable("Device OpenConnector storage is unavailable")),
      clearOpenConnectorToken: Effect.void,
      getDeviceSecrets: readStrict.pipe(Effect.orElseSucceed(() => null)),
      setDeviceSecrets: write,
      clearDeviceSecrets: Effect.tryPromise({
        try: () => rm(secretsFile, { force: true }),
        catch: () => unavailable("Failed to clear encrypted device secrets")
      }).pipe(Effect.ignore)
    })
  })

export const makeDeviceSecretStoreLive = (
  identityFile: string,
  secretsFile: string,
  initialDeviceSecrets: string
) => Layer.effect(
  SecretStore,
  makeDeviceSecretStore(identityFile, secretsFile, initialDeviceSecrets)
)
