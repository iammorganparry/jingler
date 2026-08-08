/**
 * `SecretStore` backed by Electron `safeStorage` — the OS credential vault
 * (macOS Keychain / Windows DPAPI / Linux libsecret). This is the most trusted
 * store available to an Electron app and is preferred over the unmaintained
 * `keytar`. Only ciphertext is ever written to `~/jingler/auth.enc`; if the OS
 * vault is unavailable we refuse to persist (forcing re-login) rather than fall
 * back to plaintext.
 */
import { FileSystem } from "@effect/platform"
import {
  AppPaths,
  SecretStore,
  SecretStoreUnavailable
} from "@jingler/cli-adapters"
import { Effect, Layer } from "effect"
import { safeStorage } from "electron"

/**
 * A plaintext, file-backed `SecretStore` used ONLY by the e2e harness (selected
 * in `runtime.ts` via `JINGLER_SECRET_STORE=memory`). It sidesteps the OS
 * keychain — which would prompt / be unavailable under headless Playwright — so
 * the sign-in flow can be driven deterministically. NEVER used in a real build;
 * the production path is always `SecretStoreLive` below.
 */
export const PlaintextSecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* AppPaths
    // One factory, two files: the auth token and the OpenConnector token stay in
    // SEPARATE files (`authFile` vs `openConnectorFile`) but share identical logic,
    // so a fix lands once and can't drift between them.
    const slot = (path: string) => ({
      get: fs.readFileString(path).pipe(
        Effect.map((raw) => (raw.trim().length > 0 ? raw.trim() : null)),
        Effect.orElseSucceed(() => null)
      ),
      set: (token: string) =>
        fs
          .writeFileString(path, token)
          .pipe(
            Effect.mapError(
              () => new SecretStoreUnavailable({ message: "e2e write failed" })
            )
          ),
      clear: fs.remove(path).pipe(Effect.ignore)
    })
    const auth = slot(paths.authFile)
    const openConnector = slot(paths.openConnectorFile)
    const deviceSecrets = slot(`${paths.authFile}.devices`)
    return {
      get: auth.get,
      set: auth.set,
      clear: auth.clear,
      getOpenConnectorToken: openConnector.get,
      setOpenConnectorToken: openConnector.set,
      clearOpenConnectorToken: openConnector.clear,
      getDeviceSecrets: deviceSecrets.get,
      setDeviceSecrets: deviceSecrets.set,
      clearDeviceSecrets: deviceSecrets.clear
    }
  })
)

export const SecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* AppPaths
    // One factory, two files: `authFile` and `openConnectorFile` are independent
    // ciphertext blobs but share identical encrypt/decrypt handling, so a change to
    // (say) the decrypt error path lands once instead of drifting between them.
    const slot = (path: string) => ({
      get: Effect.gen(function* () {
        const exists = yield* fs
          .exists(path)
          .pipe(Effect.orElseSucceed(() => false))
        if (!exists || !safeStorage.isEncryptionAvailable()) return null
        const bytes = yield* fs
          .readFile(path)
          .pipe(Effect.orElseSucceed(() => null))
        if (!bytes) return null
        return yield* Effect.try(() =>
          safeStorage.decryptString(Buffer.from(bytes))
        ).pipe(Effect.orElseSucceed(() => null))
      }),
      set: (token: string) =>
        safeStorage.isEncryptionAvailable()
          ? fs.writeFile(path, safeStorage.encryptString(token)).pipe(
              Effect.mapError(
                () =>
                  new SecretStoreUnavailable({
                    message: "failed to write encrypted token"
                  })
              )
            )
          : Effect.fail(
              new SecretStoreUnavailable({
                message: "OS encryption is unavailable on this host"
              })
            ),
      clear: fs.remove(path).pipe(Effect.ignore)
    })
    const auth = slot(paths.authFile)
    const openConnector = slot(paths.openConnectorFile)
    const deviceSecrets = slot(`${paths.authFile}.devices`)
    return {
      get: auth.get,
      set: auth.set,
      clear: auth.clear,
      getOpenConnectorToken: openConnector.get,
      setOpenConnectorToken: openConnector.set,
      clearOpenConnectorToken: openConnector.clear,
      getDeviceSecrets: deviceSecrets.get,
      setDeviceSecrets: deviceSecrets.set,
      clearDeviceSecrets: deviceSecrets.clear
    }
  })
)
