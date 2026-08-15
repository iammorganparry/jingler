import { access, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ProviderConnection,
  ProviderConnectionId
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { InMemoryProviderCredentialStore } from "../auth/credential-store.js"
import {
  PiChildCredentials,
  readChildCredential
} from "./pi-child-credentials.js"

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
)

const connection = Schema.decodeUnknownSync(ProviderConnection)({
  id: "anthropic-api",
  providerId: "anthropic",
  authKind: "api-key",
  account: null,
  targetId: "desktop",
  status: "authenticated",
  subscription: {
    entitlement: "active",
    planLabel: null,
    expiresAt: null,
    quotaLabel: null,
    rateLimitLabel: null,
    confirmedBillingRoute: "api"
  },
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z"
})

describe("PiChildCredentials", () => {
  it("materializes only the selected provider under restrictive permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-auth-"))
    roots.push(root)
    const credentials = new InMemoryProviderCredentialStore()
    await Effect.runPromise(credentials.write({
      connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("anthropic-api"),
      authKind: "api-key",
      access: "secret",
      refresh: null,
      expiresAt: null
    }))
    const children = new PiChildCredentials(root, credentials)

    const directory = await Effect.runPromise(
      children.materialize("parent-pi-session", connection)
    )

    expect(await readChildCredential(root, "parent-pi-session")).toEqual({
      anthropic: { type: "api_key", key: "secret" }
    })
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, "auth.json"))).mode & 0o777).toBe(0o600)
    }
  })

  it("clears stale parent credentials during runtime recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-auth-"))
    roots.push(root)
    const credentials = new InMemoryProviderCredentialStore()
    await Effect.runPromise(credentials.write({
      connectionId: connection.id,
      authKind: "api-key",
      access: "secret",
      refresh: null,
      expiresAt: null
    }))
    const children = new PiChildCredentials(root, credentials)
    await Effect.runPromise(children.materialize("stale", connection))

    await Effect.runPromise(children.clear())

    await expect(access(root)).rejects.toBeTruthy()
  })

  it("removes one parent session without touching another", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-auth-"))
    roots.push(root)
    const credentials = new InMemoryProviderCredentialStore()
    await Effect.runPromise(credentials.write({
      connectionId: connection.id,
      authKind: "api-key",
      access: "secret",
      refresh: null,
      expiresAt: null
    }))
    const children = new PiChildCredentials(root, credentials)
    await Effect.runPromise(children.materialize("one", connection))
    await Effect.runPromise(children.materialize("two", connection))

    await Effect.runPromise(children.remove("one"))

    await expect(access(children.directory("one"))).rejects.toBeTruthy()
    await expect(access(children.directory("two"))).resolves.toBeUndefined()
  })
})
