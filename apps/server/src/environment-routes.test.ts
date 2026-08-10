import type { Environment, ManagedEnvironment } from "@jingler/core"
import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"
import {
  createEnvironmentRoutes,
  type EnvironmentRoutesDependencies,
  type ManagedEnvironmentStore
} from "./environment-routes.js"

const managed: ManagedEnvironment = {
  kind: "managed",
  id: "managed_one",
  name: "Cloud workspace",
  platform: { os: "linux", arch: "x64" },
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    harnesses: ["codex"],
    maxConcurrentSessions: 1
  },
  state: "paused",
  agentVersion: null,
  lastSeenAt: null,
  region: "wnam",
  instanceType: "basic",
  generation: 1,
  createdAt: 200,
  updatedAt: 200
}

const owned: Environment = {
  kind: "owned",
  id: "device_one",
  name: "Build host",
  platform: { os: "darwin", arch: "arm64" },
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    harnesses: ["codex"],
    maxConcurrentSessions: 1
  },
  state: "online",
  agentVersion: "2.0.3",
  lastSeenAt: 190
}

const store = (): ManagedEnvironmentStore => ({
  create: vi.fn(async () => managed),
  listForUser: vi.fn(async () => [managed]),
  findForUser: vi.fn(async () => managed),
  renameForUser: vi.fn(async () => managed),
  setStateForUser: vi.fn(async () => managed),
  deleteForUser: vi.fn(async () => managed)
})

const harness = (overrides: Partial<EnvironmentRoutesDependencies> = {}) => {
  const dependencies: EnvironmentRoutesDependencies = {
    enabled: true,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    getUserId: async () => "user_one",
    listOwned: async () => [{ environment: owned, createdAt: 100 }],
    store: store(),
    issueGrant: async () => ({
      version: 1,
      runtimeUrl: "https://managed-runtime.test",
      grant: "signed-runtime-grant",
      expiresAt: 300
    }),
    ...overrides
  }
  const app = new Hono().route("/api/environments", createEnvironmentRoutes(() => dependencies))
  return { app, dependencies }
}

describe("environment routes", () => {
  it("lists owned and managed environments in stable created order", async () => {
    const { app } = harness()
    const response = await app.request("/api/environments")

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.environments.map((environment: Environment) => environment.id)).toEqual([
      "device_one",
      "managed_one"
    ])
  })

  it("never returns runtime grants or provider credentials", async () => {
    const { app } = harness()
    const response = await app.request("/api/environments")
    const body = await response.text()

    expect(body).not.toMatch(/signed-runtime-grant|credential|providerToken|secret/)
  })

  it("creates managed environments idempotently through the account-scoped store", async () => {
    const managedStore = store()
    const { app } = harness({ store: managedStore })
    const response = await app.request("/api/environments/managed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        name: "Cloud workspace",
        region: "wnam",
        instanceType: "basic",
        idempotencyKey: "create_workspace_one"
      })
    })

    expect(response.status).toBe(201)
    expect(managedStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_one",
        idempotencyKey: "create_workspace_one",
        instanceType: "basic"
      })
    )
  })

  it("refuses a grant for a stale managed environment generation", async () => {
    const issueGrant = vi.fn<EnvironmentRoutesDependencies["issueGrant"]>()
    const { app } = harness({ issueGrant })
    const response = await app.request("/api/environments/managed/managed_one/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        sessionId: "session_one",
        usageIntervalId: "command_one",
        expectedGeneration: 2,
        actions: ["session.start"]
      })
    })

    expect(response.status).toBe(409)
    expect(issueGrant).not.toHaveBeenCalled()
  })

  it("reserves and scopes one usage interval before issuing a runtime grant", async () => {
    const reserveStart = vi.fn(async () => ({
      status: "reserved" as const,
      reservationId: "usage_command_one"
    }))
    const issueGrant = vi.fn<EnvironmentRoutesDependencies["issueGrant"]>(
      async () => ({
        version: 1,
        runtimeUrl: "https://managed-runtime.test",
        grant: "signed-runtime-grant",
        expiresAt: 300
      })
    )
    const { app } = harness({ reserveStart, issueGrant })
    const response = await app.request(
      "/api/environments/managed/managed_one/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          sessionId: "session_one",
          usageIntervalId: "command_one",
          expectedGeneration: 1,
          actions: ["session.start"]
        })
      }
    )

    expect(response.status).toBe(200)
    expect(reserveStart).toHaveBeenCalledWith({
      userId: "user_one",
      environmentId: "managed_one",
      sessionId: "session_one",
      usageIntervalId: "command_one"
    })
    expect(issueGrant).toHaveBeenCalledWith(expect.objectContaining({
      reservationId: "usage_command_one"
    }))
  })

  it("cleans the runtime before deleting managed metadata", async () => {
    const managedStore = store()
    const destroyEnvironment = vi.fn(async () => undefined)
    const { app } = harness({ store: managedStore, destroyEnvironment })
    const response = await app.request(
      "/api/environments/managed/managed_one/delete",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, expectedGeneration: 1 })
      }
    )

    expect(response.status).toBe(200)
    expect(destroyEnvironment).toHaveBeenCalledOnce()
    expect(managedStore.deleteForUser).toHaveBeenCalledOnce()
    expect(destroyEnvironment.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      vi.mocked(managedStore.deleteForUser).mock.invocationCallOrder[0] ?? 0
    )
  })
})
