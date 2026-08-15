import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ProviderConnection,
  ProviderConnectionId
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { InMemoryProviderCredentialStore } from "../auth/credential-store.js"
import { PiChildCredentials } from "./pi-child-credentials.js"

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

const capability = (parentPiSessionId: string) => ({
  version: 1 as const,
  endpoint: "http://127.0.0.1:1234/v1/subagent-tool",
  token: "token",
  parentPiSessionId,
  targetId: "desktop",
  role: "conversation" as const,
  mode: "auto" as const,
  tools: []
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
      children.materialize(
        "parent-pi-session",
        connection,
        capability("parent-pi-session")
      )
    )

    expect(JSON.parse(await readFile(join(directory, "auth.json"), "utf8"))).toEqual({
      anthropic: { type: "api_key", key: "secret" }
    })
    expect(JSON.parse(await readFile(join(directory, "capability.json"), "utf8")))
      .toEqual(capability("parent-pi-session"))
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, "auth.json"))).mode & 0o777).toBe(0o600)
      expect((await stat(join(directory, "capability.json"))).mode & 0o777).toBe(0o600)
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
    await Effect.runPromise(children.materialize("stale", connection, capability("stale")))

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
    await Effect.runPromise(children.materialize("one", connection, capability("one")))
    await Effect.runPromise(children.materialize("two", connection, capability("two")))

    await Effect.runPromise(children.remove("one"))

    await expect(access(children.directory("one"))).rejects.toBeTruthy()
    await expect(access(children.directory("two"))).resolves.toBeUndefined()
  })
})
