import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnectionId,
  ProviderModelId
} from "@jingler/core"
import { Effect, Fiber, Option, Schema, Stream } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeAuthBroker } from "../auth/auth-broker.js"
import { InMemoryProviderCredentialStore } from "../auth/credential-store.js"
import { makeProviderConnections } from "./provider-connections.js"

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
)

describe("ProviderConnections", () => {
  it("preserves safe broker failure messages for reauthentication", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-connections-"))
    roots.push(root)
    const broker = await Effect.runPromise(makeAuthBroker({
      credentials: new InMemoryProviderCredentialStore(),
      codexOAuth: {
        login: async () => ({ access: "oauth", refresh: "refresh", expires: 1 }),
        refresh: async (credential) => credential
      },
      probe: async () => ({
        entitlement: "active",
        planLabel: null,
        quotaLabel: null,
        rateLimitLabel: null,
        billingRoute: "subscription",
        observedRoute: "fixture-subscription"
      })
    }))
    const service = await Effect.runPromise(makeProviderConnections({
      file: join(root, "connections.json"),
      broker,
      catalog: {
        list: Effect.succeed({ connections: [], refreshedAt: "now", stale: false }),
        refresh: Effect.succeed({ connections: [], refreshedAt: "now", stale: false }),
        selectable: Effect.succeed([])
      },
      codexInteraction: () => ({ prompt: async () => "browser", notify: () => undefined }),
      verifyModel: () => Effect.die("unused")
    }))

    await expect(Effect.runPromise(
      service.refresh(Schema.decodeUnknownSync(ProviderConnectionId)("missing"))
    )).rejects.toMatchObject({ message: "Provider connection not found" })
  })

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
        billingRoute: "api",
        observedRoute: "fixture-api"
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

  it("exposes every typed connection operation through one Effect service", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-connections-"))
    roots.push(root)
    const credentials = new InMemoryProviderCredentialStore()
    const refresh = vi.fn(async (credential: {
      readonly access: string
      readonly refresh: string
      readonly expires: number
    }) => ({ ...credential, expires: Date.now() + 60_000 }))
    const broker = await Effect.runPromise(makeAuthBroker({
      credentials,
      codexOAuth: {
        login: async (interaction) => {
          interaction.notify({
            type: "device_code",
            userCode: "ABCD-EFGH",
            verificationUri: "https://example.test/device"
          })
          return {
            access: "oauth-access",
            refresh: "oauth-refresh",
            expires: Date.now() + 60_000
          }
        },
        refresh
      },
      probe: async ({ authKind }) => ({
        entitlement: "active",
        planLabel: authKind === "api-key" ? "API" : "Subscription",
        quotaLabel: null,
        rateLimitLabel: null,
        billingRoute: authKind === "api-key" ? "api" : "subscription",
        observedRoute: `fixture-${authKind}`
      })
    }))
    const certification = {
      providerId: "anthropic",
      modelId: "anthropic:test",
      authRoute: {
        kind: "claude-setup-token" as const,
        observedRoute: "claude-setup-token",
        subscription: true,
        entitlementConfirmed: true,
        apiBillingFallbackObserved: false
      },
      versions: CURRENT_RUNTIME_CONTRACTS,
      provenance: "local" as const,
      capabilityProfiles: [],
      results: [],
      certifiedAt: new Date().toISOString()
    }
    const verifyModel = vi.fn(() => Effect.succeed(certification))
    const service = await Effect.runPromise(
      makeProviderConnections({
        file: join(root, "connections.json"),
        broker,
        catalog: {
          list: Effect.succeed({ connections: [], refreshedAt: "now", stale: false }),
          refresh: Effect.succeed({ connections: [], refreshedAt: "now", stale: false }),
          selectable: Effect.succeed([])
        },
        codexInteraction: () => ({ prompt: async () => "browser", notify: () => undefined }),
        verifyModel
      })
    )

    const claude = await Effect.runPromise(service.connectClaudeToken({
      id: "claude-1",
      token: "sk-ant-oat-fixture-value",
      targetId: "desktop"
    }))
    const { codex, loginEvent } = await Effect.runPromise(
      Effect.gen(function* () {
        const loginEventFiber = yield* Effect.fork(Stream.runHead(service.loginEvents))
        yield* Effect.yieldNow()
        const codex = yield* service.startCodexLogin({
          id: "codex-1",
          targetId: "desktop",
          method: "browser"
        })
        const loginEvent = Option.getOrNull(yield* Fiber.join(loginEventFiber))
        return { codex, loginEvent }
      })
    )
    const api = await Effect.runPromise(service.setApiKey({
      id: "api-1",
      providerId: "anthropic",
      apiKey: "api-secret",
      targetId: "desktop"
    }))

    expect(claude.authKind).toBe("claude-setup-token")
    expect(codex.authKind).toBe("openai-codex-oauth")
    expect(loginEvent).toMatchObject({
      type: "device-code",
      connectionId: "codex-1",
      userCode: "ABCD-EFGH"
    })
    expect(api.authKind).toBe("api-key")
    expect(await Effect.runPromise(service.status)).toHaveLength(3)
    expect(await Effect.runPromise(service.list)).toEqual({
      connections: [],
      refreshedAt: "now",
      stale: false
    })

    await Effect.runPromise(service.cancelLogin(claude.id))
    expect((await Effect.runPromise(service.refresh(claude.id))).id).toBe(claude.id)
    expect(
      await Effect.runPromise(service.verifyModel({
        connectionId: claude.id,
        modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic:test")
      }))
    ).toBe(certification)
    expect(verifyModel).toHaveBeenCalledOnce()

    await Effect.runPromise(service.logout(codex.id))
    const codexId = Schema.decodeUnknownSync(ProviderConnectionId)("codex-1")
    expect(await Effect.runPromise(credentials.read(codexId))).toBeNull()
    expect(await Effect.runPromise(service.status)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: codex.id, status: "disconnected" })])
    )

    const persisted = await readFile(join(root, "connections.json"), "utf8")
    expect(persisted).not.toContain("oauth-access")
    expect(persisted).not.toContain("oauth-refresh")
    expect(persisted).not.toContain("api-secret")
  })
})
