import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeAuthBroker } from "../auth/auth-broker.js"
import { InMemoryProviderCredentialStore } from "../auth/credential-store.js"
import { makeProviderConnections } from "./provider-connections.js"

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
)

describe("ProviderConnections", () => {
  it("persists only redacted connection metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-connections-"))
    roots.push(root)
    const file = join(root, "connections.json")
    const broker = await Effect.runPromise(makeAuthBroker({
      credentials: new InMemoryProviderCredentialStore(),
      codexOAuth: {
        login: async () => ({ access: "oauth", refresh: "refresh", expires: 1 }),
        refresh: async (credential) => credential
      },
      probe: async () => ({
        entitlement: "active",
        planLabel: "API",
        quotaLabel: null,
        rateLimitLabel: null,
        billingRoute: "api"
      })
    }))
    const service = await Effect.runPromise(
      makeProviderConnections({
        file,
        broker,
        catalog: {
          list: Effect.succeed({ connections: [], refreshedAt: "now", stale: false }),
          refresh: Effect.succeed({ connections: [], refreshedAt: "now", stale: false }),
          selectable: Effect.succeed([])
        },
        codexInteraction: () => ({
          prompt: async () => "",
          notify: () => undefined
        }),
        verifyModel: () => Effect.die("unused")
      })
    )
    await Effect.runPromise(
      service.setApiKey({
        id: "api-1",
        providerId: "anthropic",
        apiKey: "super-secret-api-key",
        targetId: "desktop"
      })
    )
    const raw = await readFile(file, "utf8")
    expect(raw).toContain('"authKind": "api-key"')
    expect(raw).not.toContain("super-secret-api-key")
  })
})
