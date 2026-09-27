import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  ProviderConnection,
  SubagentCapability
} from "@jingler/core"
import { Data, Effect } from "effect"
import type { ProviderCredentialStore } from "../auth/credential-store.js"
import { claudeCliRouteCredential, toPiCredential } from "../auth/pi-credential-store.js"

const SAFE_AGENT_NAME = /^[a-z][a-z0-9-]*$/u

export class PiChildCredentialError extends Data.TaggedError(
  "PiChildCredentialError"
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const childCredentialKey = (parentRuntimeSessionId: string): string =>
  createHash("sha256").update(parentRuntimeSessionId).digest("hex")

export const childProviderConnections = (
  parent: ProviderConnection,
  assigned: ReadonlyArray<ProviderConnection>
): ReadonlyArray<ProviderConnection> => [
  parent,
  ...assigned.filter(({ providerId }) => providerId !== parent.providerId)
]

export const childCapabilityFileName = (agent: string): string => {
  if (!SAFE_AGENT_NAME.test(agent)) throw new Error("Unsafe child agent name")
  return `capability-${agent}.json`
}

export class PiChildCredentials {
  constructor(
    readonly root: string,
    readonly credentials: ProviderCredentialStore
  ) {}

  directory(parentRuntimeSessionId: string): string {
    return join(this.root, childCredentialKey(parentRuntimeSessionId))
  }

  materialize(
    parentRuntimeSessionId: string,
    connections: ReadonlyArray<ProviderConnection>,
    capabilities: ReadonlyArray<SubagentCapability>
  ): Effect.Effect<string, PiChildCredentialError> {
    const providers = new Set(connections.map(({ providerId }) => providerId))
    if (connections.length === 0 || providers.size !== connections.length) {
      return Effect.fail(new PiChildCredentialError({
        message: "Subagent credentials require one connection per provider"
      }))
    }
    return Effect.all(connections.map((connection) =>
      this.credentials.read(connection.id).pipe(
        Effect.map((stored) => ({
          connection,
          stored: stored ?? claudeCliRouteCredential(connection)
        }))
      )
    )).pipe(
      Effect.mapError(
        (cause) =>
          new PiChildCredentialError({
            message: "Could not read the selected provider credentials",
            cause
          })
      ),
      Effect.flatMap((resolved) =>
        resolved.some(({ stored }) => stored === null)
          ? Effect.fail(
              new PiChildCredentialError({
                message: "A selected provider credential is unavailable"
              })
            )
          : Effect.tryPromise({
              try: async () => {
                if (
                  capabilities.length === 0 ||
                  capabilities.some(
                    (capability) => capability.parentRuntimeSessionId !== parentRuntimeSessionId
                  )
                ) {
                  throw new Error("Child capabilities do not match their parent session")
                }
                const directory = this.directory(parentRuntimeSessionId)
                const authPath = join(directory, "auth.json")
                const capabilityPaths = capabilities.map((capability) => ({
                  capability,
                  path: join(directory, childCapabilityFileName(capability.agent))
                }))
                const nonce = `${process.pid}.${randomUUID()}.next`
                const temporary = [
                  {
                    path: `${authPath}.${nonce}`,
                    content: `${JSON.stringify(Object.fromEntries(
                      resolved.map(({ connection, stored }) => [
                        connection.providerId,
                        toPiCredential(connection, stored!)
                      ])
                    ))}\n`
                  },
                  ...capabilityPaths.map(({ capability, path }) => ({
                    path: `${path}.${nonce}`,
                    content: `${JSON.stringify(capability)}\n`
                  }))
                ]
                await mkdir(directory, { recursive: true, mode: 0o700 })
                await chmod(directory, 0o700)
                try {
                  await Promise.all(temporary.map(({ path, content }) =>
                    writeFile(path, content, {
                      encoding: "utf8",
                      flag: "wx",
                      mode: 0o600
                    })
                  ))
                  await rename(temporary[0]!.path, authPath)
                  await Promise.all(capabilityPaths.map(({ path }, index) =>
                    rename(temporary[index + 1]!.path, path)
                  ))
                  await Promise.all([
                    chmod(authPath, 0o600),
                    ...capabilityPaths.map(({ path }) => chmod(path, 0o600))
                  ])
                } catch (error) {
                  await Promise.all(
                    temporary.map(({ path }) => rm(path, { force: true }))
                  )
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

  remove(parentRuntimeSessionId: string): Effect.Effect<void> {
    return Effect.promise(() =>
      rm(this.directory(parentRuntimeSessionId), { recursive: true, force: true })
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
