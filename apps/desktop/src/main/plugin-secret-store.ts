/**
 * File-backed plugin secret settings.
 *
 * Production encrypts the entire namespaced document with Electron
 * `safeStorage` before it reaches disk. The e2e harness uses the plaintext
 * codec only inside its isolated `JINGLER_HOME`, because the headless Electron
 * process cannot rely on an OS credential vault.
 */
import { join } from "node:path"
import { FileSystem } from "@effect/platform"
import {
  AppPaths,
  PluginSecretStore,
  PluginSecretStoreUnavailable,
  type PluginSecretStoreShape
} from "@jingler/cli-adapters"
import { Effect, Layer, Schema } from "effect"
import { safeStorage } from "electron"

const SecretDocument = Schema.Record({
  key: Schema.String,
  value: Schema.Record({ key: Schema.String, value: Schema.String })
})
type SecretDocument = Schema.Schema.Type<typeof SecretDocument>

export interface PluginSecretCodec {
  readonly available: () => boolean
  readonly encrypt: (plaintext: string) => Uint8Array
  readonly decrypt: (ciphertext: Uint8Array) => string
}

const unavailable = (message: string) =>
  new PluginSecretStoreUnavailable({ message })

/**
 * Build the document store around a codec.
 *
 * Exported so tests can prove bytes on disk are encoded without mocking the
 * service itself. Callers never receive the document — only namespaced values
 * and boolean status.
 */
export const makeFilePluginSecretStore = (
  codec: PluginSecretCodec
): Effect.Effect<PluginSecretStoreShape, never, FileSystem.FileSystem | AppPaths> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* AppPaths
    const file = join(paths.root, "plugin-secrets.enc")
    const lock = Effect.unsafeMakeSemaphore(1)

    const read = Effect.gen(function* () {
      const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
      if (!exists) return {}
      if (!codec.available()) {
        return yield* Effect.fail(
          unavailable("Secure plugin settings are unavailable because OS encryption is unavailable.")
        )
      }
      const bytes = yield* fs.readFile(file).pipe(
        Effect.mapError(() => unavailable("Could not read encrypted plugin settings."))
      )
      const plaintext = yield* Effect.try({
        try: () => codec.decrypt(bytes),
        catch: () => unavailable("Could not decrypt encrypted plugin settings.")
      })
      return yield* Schema.decodeUnknown(Schema.parseJson(SecretDocument))(plaintext).pipe(
        Effect.mapError(() =>
          unavailable("Encrypted plugin settings contain an invalid document.")
        )
      )
    })

    const write = (document: SecretDocument) =>
      Effect.gen(function* () {
        if (!codec.available()) {
          return yield* Effect.fail(
            unavailable("Secure plugin settings cannot be saved because OS encryption is unavailable.")
          )
        }
        const bytes = yield* Effect.try({
          try: () => codec.encrypt(JSON.stringify(document)),
          catch: () => unavailable("Could not encrypt plugin settings.")
        })
        yield* fs.makeDirectory(paths.root, { recursive: true }).pipe(
          Effect.mapError(() => unavailable("Could not create the plugin settings directory."))
        )
        yield* fs.writeFile(file, bytes).pipe(
          Effect.mapError(() => unavailable("Could not persist encrypted plugin settings."))
        )
      })

    const get = (pluginId: string, settingId: string) =>
      read.pipe(
        Effect.map((all) => all[pluginId]?.[settingId] ?? null),
        // A read must not make plugin activation fail for an OS-vault outage.
        // The host sees an unconfigured secret and can point the operator back
        // to Settings; writes still surface the precise persistence failure.
        Effect.orElseSucceed(() => null)
      )

    const update = (
      change: (document: SecretDocument) => SecretDocument
    ): Effect.Effect<void, PluginSecretStoreUnavailable> =>
      lock.withPermits(1)(
        Effect.flatMap(read, (current) => {
          const next = change(current)
          return next === current ? Effect.void : write(next)
        })
      )

    return {
      get,
      set: (pluginId, settingId, value) =>
        update((all) => ({
          ...all,
          [pluginId]: { ...all[pluginId], [settingId]: value }
        })),
      clear: (pluginId, settingId) =>
        update((all) => {
          const plugin = all[pluginId]
          if (!plugin || !(settingId in plugin)) return all
          const { [settingId]: _removed, ...remaining } = plugin
          if (Object.keys(remaining).length > 0) {
            return { ...all, [pluginId]: remaining }
          }
          const { [pluginId]: _emptyPlugin, ...otherPlugins } = all
          return otherPlugins
        }),
      status: (pluginId, settingId) =>
        get(pluginId, settingId).pipe(Effect.map((value) => value !== null)),
      clearPlugin: (pluginId) =>
        update((all) => {
          if (!(pluginId in all)) return all
          const { [pluginId]: _removed, ...remaining } = all
          return remaining
        })
    }
  })

const encryptedCodec: PluginSecretCodec = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plaintext) => safeStorage.encryptString(plaintext),
  decrypt: (ciphertext) => safeStorage.decryptString(Buffer.from(ciphertext))
}

const plaintextCodec: PluginSecretCodec = {
  available: () => true,
  encrypt: (plaintext) => Buffer.from(plaintext, "utf8"),
  decrypt: (bytes) => Buffer.from(bytes).toString("utf8")
}

export const PluginSecretStoreLive = Layer.effect(
  PluginSecretStore,
  makeFilePluginSecretStore(encryptedCodec)
)

/** E2e-only: selected exclusively by `JINGLER_SECRET_STORE=memory`. */
export const PlaintextPluginSecretStoreLive = Layer.effect(
  PluginSecretStore,
  makeFilePluginSecretStore(plaintextCodec)
)
