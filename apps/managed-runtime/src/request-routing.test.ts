import { describe, expect, it, vi } from "vitest"
import type { ManagedRuntimeEnv } from "./runtime-env.js"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: DurableObjectState,
      readonly env: ManagedRuntimeEnv
    ) {}
  },
  WorkflowEntrypoint: class {}
}))
vi.mock("@cloudflare/sandbox", () => ({ Sandbox: class {}, getSandbox: vi.fn() }))

import worker from "./index.js"
import { ManagedAccountObject } from "./account-runtime.js"
import { ManagedAuthSubscriptionLedger } from "./auth-subscription.js"
import { ManagedSessionObject } from "./session-runtime.js"

const context = () => {
  const values = new Map<string, unknown>()
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value)
    }),
    setAlarm: vi.fn(async () => undefined)
  }
  return { values, storage, state: { storage } as unknown as DurableObjectState }
}
const post = (path: string, body: unknown) =>
  new Request(`https://runtime.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })
const env = { MANAGED_RUNTIME_SERVICE_SECRET: "s".repeat(32) } as ManagedRuntimeEnv
const execution = { waitUntil: vi.fn() } as unknown as ExecutionContext

const configuration = {
  subject: "user_one",
  environmentId: "managed_one",
  environmentGeneration: 3,
  sessionId: "session_one",
  authStateVersion: 7,
  connectionId: "connection_one",
  providerId: "anthropic",
  modelId: "anthropic/claude-fable-5",
  reservationId: null,
  providerConnection: {
    version: 1,
    connectionId: "connection_one",
    providerId: "anthropic",
    authKind: "claude-setup-token",
    billingRoute: "subscription",
    proxy: "claude",
    handle: "credential_one",
    expiresAt: 2_000_000_000
  },
  webSearchCapabilities: [],
  githubCapabilityHandle: null
}

describe("managed request dispatch", () => {
  it.each([
    "/v1/grants",
    "/v1/offload/grants",
    "/v1/workspaces/hydrate",
    "/v1/environments/destroy"
  ])("checks service authorization before decoding %s", async (path) => {
    const response = await worker.fetch(
      new Request(`https://runtime.test${path}`, {
        method: "POST",
        body: "invalid JSON"
      }),
      env,
      execution
    )
    expect(response.status).toBe(401)
  })

  it("retains health routing independent of method and rejects unknown routes", async () => {
    expect((await worker.fetch(post("/health", null), env, execution)).status).toBe(200)
    expect((await worker.fetch(post("/unknown", null), env, execution)).status).toBe(404)
    expect(
      (await worker.fetch(new Request("https://runtime.test/v1/grants"), env, execution)).status
    ).toBe(404)
  })

  it("rejects malformed forwarded session identifiers before namespace access", async () => {
    const response = await worker.fetch(
      new Request("https://runtime.test/v1/sessions/%ZZ/events"),
      env,
      execution
    )
    expect(response.status).toBe(400)
  })

  it("consumes account grants once and preserves the subject requirement", async () => {
    const { state, values } = context()
    const account = new ManagedAccountObject(state, env)
    expect((await account.fetch(post("/v1/offload/grants/consume", {}))).status).toBe(400)
    const body = { subject: "user_one", use: "grant_one:snapshot.upload" }
    expect((await account.fetch(post("/v1/offload/grants/consume", body))).status).toBe(200)
    expect((await account.fetch(post("/v1/offload/grants/consume", body))).status).toBe(409)
    expect(values.get("offload-grant-uses")).toEqual([body.use])
    expect((await account.fetch(post("/unknown", body))).status).toBe(404)
  })

  it("handles configuration and auth updates before the configured-session guard", async () => {
    const { state } = context()
    const session = new ManagedSessionObject(state, env)
    expect((await session.fetch(post("/v1/auth-state", {}))).status).toBe(200)
    expect((await session.fetch(post("/v1/configure", {}))).status).toBe(400)
    expect((await session.fetch(post("/unknown", {}))).status).toBe(409)
    const response = await session.fetch(post("/v1/configure", configuration))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionGeneration: 1 })
    expect((await session.fetch(post("/unknown", {}))).status).toBe(404)
    expect(
      (await session.fetch(post("/v1/configure", { ...configuration, subject: "user_other" })))
        .status
    ).toBe(409)
  })
  it("retains offload idempotency, concurrency and release behavior", async () => {
    const { state, values } = context()
    const now = Math.floor(Date.now() / 1_000)
    const ledger = new ManagedAuthSubscriptionLedger("user_one")
    ledger.apply(
      {
        subject: "user_one",
        version: 1,
        issuedAt: now,
        expiresAt: now + 600,
        capabilities: ["managed.session.execute"],
        providerConnections: [],
        credentialCapabilities: [{ provider: "github", handle: "github_one", expiresAt: now + 600 }]
      },
      { leaseExpiresAt: now + 500 }
    )
    values.set("auth-coordinator", ledger.snapshot())
    const account = new ManagedAccountObject(state, env)
    const register = (jobId: string, idempotencyKey: string) =>
      account.fetch(
        post("/v1/offload/register", {
          subject: "user_one",
          jobId,
          idempotencyKey
        })
      )
    expect(await (await register("job_one", "key_one")).json()).toMatchObject({ claimed: true })
    expect(await (await register("job_one", "key_one")).json()).toMatchObject({ claimed: false })
    expect((await register("job_two", "key_one")).status).toBe(409)
    expect((await register("job_two", "key_two")).status).toBe(429)
    await account.fetch(post("/v1/offload/unregister", { subject: "user_one", jobId: "job_one" }))
    expect(await (await register("job_two", "key_two")).json()).toMatchObject({ claimed: true })
  })

  it("preserves existing session metadata and rejects active provider changes", async () => {
    const { state, values } = context()
    const session = new ManagedSessionObject(state, env)
    await session.fetch(post("/v1/configure", configuration))
    const previous = values.get("runtime-metadata") as Record<string, unknown>
    values.set("runtime-metadata", {
      ...previous,
      sessionGeneration: 4,
      processId: "command_one",
      providerTokenHash: "provider_hash",
      gitTokenHash: "git_hash",
      usageReservationId: "reservation_one",
      usageStartedAt: 123
    })
    expect(
      (await session.fetch(post("/v1/configure", { ...configuration, modelId: "other-model" })))
        .status
    ).toBe(409)
    expect((await session.fetch(post("/v1/configure", configuration))).status).toBe(200)
    expect(values.get("runtime-metadata")).toMatchObject({
      sessionGeneration: 4,
      processId: "command_one",
      providerTokenHash: "provider_hash",
      gitTokenHash: "git_hash",
      usageReservationId: "reservation_one",
      usageStartedAt: 123
    })
  })
})
