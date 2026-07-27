/**
 * A secret store for the signed-in session token. The tag lives here (so
 * `AuthService` can depend on it and tests can supply a fake), while the real
 * implementation — Electron `safeStorage`, the OS credential vault — is provided
 * by the main process (`apps/desktop/src/main/secret-store.ts`), keeping
 * `cli-adapters` free of any `electron` import.
 *
 * Security contract: `set` NEVER writes plaintext. If the OS vault is
 * unavailable it fails with `SecretStoreUnavailable` rather than degrade, so a
 * missing keychain forces re-login instead of leaking a bearer token to disk.
 */
import { Context, Data, Effect, Layer, Ref } from "effect"

export class SecretStoreUnavailable extends Data.TaggedError("SecretStoreUnavailable")<{
  readonly message: string
}> {}

export interface SecretStoreShape {
  /** The stored token, or null when signed out / unavailable. Never fails. */
  readonly get: Effect.Effect<string | null>
  /** Persist the token as ciphertext. Fails if the OS vault is unavailable. */
  readonly set: (token: string) => Effect.Effect<void, SecretStoreUnavailable>
  /** Remove the stored token (idempotent). */
  readonly clear: Effect.Effect<void>
  /**
   * The OpenConnector instance's bearer token, or null when unset / unavailable.
   * Stored in a SEPARATE encrypted file from the sign-in token (`openConnectorFile`
   * vs `authFile`), so it survives sign-out. Never fails.
   */
  readonly getOpenConnectorToken: Effect.Effect<string | null>
  /** Persist the OpenConnector token as ciphertext. Fails if the OS vault is unavailable. */
  readonly setOpenConnectorToken: (token: string) => Effect.Effect<void, SecretStoreUnavailable>
  /** Remove the stored OpenConnector token (idempotent). */
  readonly clearOpenConnectorToken: Effect.Effect<void>
}

export class SecretStore extends Context.Tag("@jingler/SecretStore")<
  SecretStore,
  SecretStoreShape
>() {}

/** Build an in-memory store (tests + the e2e harness seed a starting token). */
export const makeInMemorySecretStore = (
  initial: string | null = null,
  initialOpenConnector: string | null = null
): Effect.Effect<SecretStoreShape> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<string | null>(initial)
    const ocRef = yield* Ref.make<string | null>(initialOpenConnector)
    return {
      get: Ref.get(ref),
      set: (token: string) => Ref.set(ref, token),
      clear: Ref.set(ref, null),
      getOpenConnectorToken: Ref.get(ocRef),
      setOpenConnectorToken: (token: string) => Ref.set(ocRef, token),
      clearOpenConnectorToken: Ref.set(ocRef, null)
    }
  })

/** An in-memory `SecretStore` layer, signed out by default. */
export const InMemorySecretStoreLive = Layer.effect(SecretStore, makeInMemorySecretStore())
