import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProviderConnection } from "@jingler/core"
import { Data, Effect } from "effect"
import type { ProviderCredentialStore } from "../auth/credential-store.js"
import { toPiCredential } from "../auth/pi-credential-store.js"

export class PiChildCredentialError extends Data.TaggedError(
  "PiChildCredentialError"
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const childCredentialKey = (parentPiSessionId: string): string =>
  createHash("sha256").update(parentPiSessionId).digest("hex")

export class PiChildCredentials {
  constructor(
    readonly root: string,
    readonly credentials: ProviderCredentialStore
  ) {}

  directory(parentPiSessionId: string): string {
    return join(this.root, childCredentialKey(parentPiSessionId))
  }

  materialize(
    parentPiSessionId: string,
    connection: ProviderConnection
  ): Effect.Effect<string, PiChildCredentialError> {
    return this.credentials.read(connection.id).pipe(
      Effect.mapError(
        (cause) =>
          new PiChildCredentialError({
            message: "Could not read the selected provider credential",
            cause
          })
      ),
      Effect.flatMap((stored) =>
        stored === null
          ? Effect.fail(
              new PiChildCredentialError({
                message: "The selected provider credential is unavailable"
              })
            )
          : Effect.tryPromise({
              try: async () => {
                const directory = this.directory(parentPiSessionId)
                const authPath = join(directory, "auth.json")
                const temporary = `${authPath}.${process.pid}.next`
                await mkdir(directory, { recursive: true, mode: 0o700 })
                await chmod(directory, 0o700)
                try {
                  await writeFile(
                    temporary,
                    `${JSON.stringify({
                      [connection.providerId]: toPiCredential(stored)
                    })}\n`,
                    { encoding: "utf8", flag: "wx", mode: 0o600 }
                  )
                  await rename(temporary, authPath)
                  await chmod(authPath, 0o600)
                } catch (error) {
                  await rm(temporary, { force: true })
                  throw error
                }
                return directory
              },
              catch: (cause) =>
                new PiChildCredentialError({
                  message: "Could not materialize the child provider credential",
                  cause
                })
            })
      )
    )
  }

  remove(parentPiSessionId: string): Effect.Effect<void> {
    return Effect.promise(() =>
      rm(this.directory(parentPiSessionId), { recursive: true, force: true })
    )
  }

  /** Remove directories that no longer belong to a live parent after restart. */
  clear(): Effect.Effect<void, PiChildCredentialError> {
    return Effect.tryPromise({
      try: () => rm(this.root, { recursive: true, force: true }),
      catch: (cause) =>
        new PiChildCredentialError({
          message: "Could not clear stale child credentials",
          cause
        })
    })
  }
}

export const readChildCredential = (
  root: string,
  parentPiSessionId: string
): Promise<unknown> =>
  readFile(
    join(root, childCredentialKey(parentPiSessionId), "auth.json"),
    "utf8"
  ).then(JSON.parse)
