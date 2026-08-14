import {
  OffloadAdmissionError,
  type OffloadAdmissionRequest,
  type OffloadAdmissionResponse
} from "@jingler/core"
import { Effect, Layer } from "effect"
import { describe, expect, it, vi } from "vitest"
import {
  createManagedOffloadRoutes,
  ManagedOffloadPorts,
  type ManagedOffloadPortShape
} from "./managed-offload.js"

const request: OffloadAdmissionRequest = {
  version: 1,
  sessionId: "session_aaaaaaaaaaaaaaaa",
  idempotencyKey: "request_aaaaaaaaaaaaaaaa",
  repositorySlug: "jingler/example",
  snapshot: {
    version: 1,
    headSha: "a".repeat(40),
    digest: "b".repeat(64),
    bytes: 1024
  },
  command: {
    source: { kind: "preset", preset: "typecheck" },
    executable: "pnpm",
    args: ["typecheck"],
    cwd: "."
  },
  limits: {
    timeoutSeconds: 300,
    snapshotBytes: 1024,
    outputBytes: 1024
  }
}

const response: OffloadAdmissionResponse = {
  version: 1,
  jobId: "job_aaaaaaaaaaaaaaaa",
  runtimeUrl: "https://managed-runtime.test",
  uploadUrl: "https://managed-runtime.test/v1/offload/jobs/job_aaaaaaaaaaaaaaaa/snapshot",
  grant: "grant_aaaaaaaaaaaaaaaa",
  expiresAt: 2_000_000_000
}

const failure = (
  reason: OffloadAdmissionError["reason"],
  message: string
): OffloadAdmissionError => new OffloadAdmissionError({ reason, message })

const harness = (overrides: Partial<ManagedOffloadPortShape> = {}) => {
  const authenticate = vi.fn(() => Effect.succeed<string | null>("user_one"))
  const authorizeRepository = vi.fn(() => Effect.void)
  const issueRuntimeGrant = vi.fn(() => Effect.succeed(response))
  const ports: ManagedOffloadPortShape = {
    enabled: true,
    authenticate,
    authorizeRepository,
    issueRuntimeGrant,
    ...overrides
  }
  const app = createManagedOffloadRoutes(Layer.succeed(ManagedOffloadPorts, ports))
  return { app, ports, authenticate, authorizeRepository, issueRuntimeGrant }
}

describe("managed offload admission", () => {
  it("derives the subject from authentication and scopes the runtime request", async () => {
    const { app, authorizeRepository, issueRuntimeGrant } = harness()
    const admitted = await app.request("http://localhost/jobs", {
      method: "POST",
      headers: {
        authorization: "Bearer desktop-session",
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    })

    expect(admitted.status).toBe(200)
    expect(await admitted.json()).toEqual(response)
    expect(authorizeRepository).toHaveBeenCalledWith("user_one", "jingler/example")
    expect(issueRuntimeGrant).toHaveBeenCalledWith({
      subject: "user_one",
      request
    })
  })

  it("does not accept an authoritative subject from the client", async () => {
    const { app, issueRuntimeGrant } = harness()
    const denied = await app.request("http://localhost/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, subject: "user_two" })
    })
    expect(denied.status).toBe(400)
    expect(issueRuntimeGrant).not.toHaveBeenCalled()
  })

  it.each([
    [false, "user_one", 404],
    [true, null, 401]
  ] as const)("enforces feature=%s and authenticated subject=%s", async (enabled, subject, status) => {
    const { app, issueRuntimeGrant } = harness({
      enabled,
      authenticate: () => Effect.succeed(subject)
    })
    const denied = await app.request("http://localhost/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    })
    expect(denied.status).toBe(status)
    expect(issueRuntimeGrant).not.toHaveBeenCalled()
  })
})

describe("managed offload runtime denials", () => {
  it.each([
    ["authorization", 403],
    ["concurrency", 429],
    ["unavailable", 503]
  ] as const)("preserves the %s denial boundary", async (reason, status) => {
    const { app } = harness({
      issueRuntimeGrant: () =>
        Effect.fail(failure(reason, `Runtime denied ${reason}`))
    })
    const denied = await app.request("http://localhost/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    })
    expect(denied.status).toBe(status)
    expect(await denied.json()).toEqual({ error: `Runtime denied ${reason}` })
  })

  it("does not admit a replayed idempotency key", async () => {
    const seen = new Set<string>()
    const { app } = harness({
      issueRuntimeGrant: ({ request: candidate }) => {
        if (seen.has(candidate.idempotencyKey)) {
          return Effect.fail(failure("concurrency", "Offload request already admitted"))
        }
        seen.add(candidate.idempotencyKey)
        return Effect.succeed(response)
      }
    })
    const send = () => app.request("http://localhost/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    })
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(429)
  })

  it("denies a digest that the runtime does not accept", async () => {
    const { app } = harness({
      issueRuntimeGrant: ({ request: candidate }) =>
        candidate.snapshot.digest === "c".repeat(64)
          ? Effect.succeed(response)
          : Effect.fail(failure("authorization", "Snapshot digest scope denied"))
    })
    const denied = await app.request("http://localhost/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    })
    expect(denied.status).toBe(403)
  })
})
