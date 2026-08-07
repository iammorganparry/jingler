import { Effect } from "effect"
import { serializeMemoryMarkdown, type MemoryPage, type MemorySource } from "@jingler/memory"
import { describe, expect, it, vi } from "vitest"
import { VAULT_ORGANIZATION_HEADER, workflowBindingId, workflowBindingIds } from "./auth.js"
import {
  createOrReuseScopedWorkflow,
  handleMemoryWorkerRequest,
  handleTeamVaultRequest
} from "./api.js"
import type {
  DurableObjectIdLike,
  DurableObjectNamespaceLike,
  DurableObjectStubLike,
  MemoryWorkerEnv,
  R2PutOptionsLike,
  WorkflowBindingLike,
  WorkflowInstanceLike
} from "./env.js"
import type { VectorIngestWorkflowInput } from "./workflows/vector-ingest.js"
import { InMemoryR2Bucket, organizationPrefix } from "./r2-store.js"
import memoryWorker, { memoryWorkerHealthResponse } from "./index.js"
import { InMemoryVaultState, TeamVault } from "./team-vault.js"

// Runs an Effect-returning vault/layer/state method to a Promise at the test boundary.
const run = Effect.runPromise


class TestDurableObjectId implements DurableObjectIdLike {
  constructor(readonly name: string) {}

  toString(): string {
    return this.name
  }
}

class TestVaultNamespace implements DurableObjectNamespaceLike {
  private readonly vaults = new Map<string, Promise<TeamVault>>()

  constructor(private readonly bucket: InMemoryR2Bucket) {}

  idFromName(name: string): DurableObjectIdLike {
    return new TestDurableObjectId(name)
  }

  get(id: DurableObjectIdLike): DurableObjectStubLike {
    const organizationId = id.name
    if (organizationId === undefined) throw new Error("test Durable Object id has no name")
    let vault = this.vaults.get(organizationId)
    if (vault === undefined) {
      vault = run(TeamVault.create(organizationId, new InMemoryVaultState(), this.bucket))
      this.vaults.set(organizationId, vault)
    }
    return {
      fetch: async (request) => {
        if (request.headers.get(VAULT_ORGANIZATION_HEADER) !== organizationId) {
          return new Response("scope mismatch", { status: 403 })
        }
        return handleTeamVaultRequest(request, await vault)
      }
    }
  }
}

class FailNextRevisionPutBucket extends InMemoryR2Bucket {
  private failNextRevisionPut = false

  failNextRevisionPutForTest(): void {
    this.failNextRevisionPut = true
  }

  override async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: R2PutOptionsLike
  ): Promise<{ readonly key: string } | null> {
    if (this.failNextRevisionPut && key.includes("/revisions/")) {
      this.failNextRevisionPut = false
      throw new Error("transient revision persistence failure")
    }
    return super.put(key, value, options)
  }
}

describe("workflow rotation deduplication", () => {
  it("keeps new workflow ids stable when the service credential rotates", async () => {
    const before = await workflowBindingIds(
      { MEMORY_WORKFLOW_ID_SECRET: "stable-workflow-secret", MEMORY_SERVICE_SECRET: "service-a" },
      "org-a",
      "compiler-stable"
    )
    const after = await workflowBindingIds(
      {
        MEMORY_WORKFLOW_ID_SECRET: "stable-workflow-secret",
        MEMORY_SERVICE_SECRET: "service-b",
        MEMORY_SERVICE_SECRET_PREVIOUS: "service-a"
      },
      "org-a",
      "compiler-stable"
    )
    expect(after[0]).toBe(before[0])
  })

  it("reuses an instance created with the previous service secret", async () => {
    const bucket = new InMemoryR2Bucket()
    const previousId = await workflowBindingId("previous-secret", "org-a", "compiler-stable")
    let creates = 0
    const binding: WorkflowBindingLike<{ readonly workflowId: string }> = {
      create: async ({ id }) => {
        creates += 1
        return { id, status: async () => ({ status: "queued" }) }
      },
      get: async (id) => {
        if (id !== previousId) throw new Error("instance absent")
        return { id, status: async () => ({ status: "running" }) }
      }
    }
    const env: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_SERVICE_SECRET: "current-secret",
      MEMORY_SERVICE_SECRET_PREVIOUS: "previous-secret"
    }

    await createOrReuseScopedWorkflow(
      binding,
      env,
      "org-a",
      "compiler-stable",
      { workflowId: "compiler-stable" }
    )

    expect(creates).toBe(0)
  })
})

const source: MemorySource = { id: "source-stable", kind: "manual", title: "Stable source" }

const page = (organization: string, revision = 1): MemoryPage => ({
  id: "shared-slug",
  path: "shared-slug.md",
  title: "Shared slug",
  revision,
  aliases: [],
  tags: [organization],
  sources: [],
  citations: [{ id: "citation-stable", sourceId: source.id }],
  relationships: [],
  body: `# Shared slug\n\nThe ${organization} private-${organization} fact is supported. [@citation-stable]\n`,
  metadata: {}
})

const jsonRequest = (
  organizationId: string,
  path: string,
  body: unknown,
  secret = "current-secret"
): Request =>
  new Request(`https://memory.test${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-jingler-organization-id": organizationId
    },
    body: JSON.stringify(body)
  })

const getRequest = (organizationId: string, path: string, secret = "current-secret"): Request =>
  new Request(`https://memory.test${path}`, {
    headers: {
      authorization: `Bearer ${secret}`,
      "x-jingler-organization-id": organizationId
    }
  })

const jsonBody = async (response: Response): Promise<unknown> => response.json()

const readyWorkflow = {
  create: async ({ id }: { readonly id: string }) => ({
    id,
    status: async () => ({ status: "queued" })
  }),
  get: async (id: string) => ({ id, status: async () => ({ status: "queued" }) })
}

describe("memory Worker internal API", () => {
  it("reports binding readiness without exposing service credentials", async () => {
    const bucket = new InMemoryR2Bucket()
    const response = memoryWorkerHealthResponse({
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_COMPILER: readyWorkflow,
      MEMORY_LINT: readyWorkflow,
      MEMORY_SERVICE_SECRET: "secret-that-must-not-escape"
    })
    expect(response.status).toBe(200)
    const body = JSON.stringify(await response.json())
    expect(body).toContain('"durableObjects":true')
    expect(body).toContain('"r2":true')
    expect(body).not.toContain("secret-that-must-not-escape")
  })

  it("reports degraded readiness when a required binding is absent", async () => {
    const bucket = new InMemoryR2Bucket()
    const response = memoryWorkerHealthResponse({
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_COMPILER: readyWorkflow,
      MEMORY_SERVICE_SECRET: "secret"
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      status: "degraded",
      bindings: { lintWorkflow: false }
    })
  })

  it("warns when the retired manual review gate remains configured", async () => {
    const bucket = new InMemoryR2Bucket()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const response = await memoryWorker.fetch(
        new Request("https://memory.test/health"),
        {
          MEMORY_R2: bucket,
          MEMORY_VAULTS: new TestVaultNamespace(bucket),
          MEMORY_COMPILER: readyWorkflow,
          MEMORY_LINT: readyWorkflow,
          MEMORY_SERVICE_SECRET: "secret",
          MEMORY_REQUIRE_REVIEW: "true"
        }
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        warnings: [
          "MEMORY_REQUIRE_REVIEW is retired and ignored; remove it because agent memory publication is automatic."
        ]
      })
      expect(warn).toHaveBeenCalledWith(
        "MEMORY_REQUIRE_REVIEW is retired and ignored; remove it because agent memory publication is automatic."
      )
    } finally {
      warn.mockRestore()
    }
  })

  it("requires rotating service authentication and an organization scope", async () => {
    const bucket = new InMemoryR2Bucket()
    const env: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_SERVICE_SECRET: "current-secret",
      MEMORY_SERVICE_SECRET_PREVIOUS: "previous-secret"
    }
    const missing = await handleMemoryWorkerRequest(
      new Request("https://memory.test/internal/memory/pages"),
      env
    )
    expect(missing.status).toBe(401)
    expect(
      (
        await handleMemoryWorkerRequest(
          getRequest("org-a", "/internal/memory/pages", "wrong-secret"),
          env
        )
      ).status
    ).toBe(401)
    expect(
      (
        await handleMemoryWorkerRequest(
          getRequest("../other", "/internal/memory/pages"),
          env
        )
      ).status
    ).toBe(403)
    expect(
      (
        await handleMemoryWorkerRequest(
          getRequest("org-a", "/internal/memory/pages", "previous-secret"),
          env
        )
      ).status
    ).toBe(200)
  })

  it("stores bounded session retrieval counters and exposes only aggregates", async () => {
    const bucket = new InMemoryR2Bucket()
    const env: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_SERVICE_SECRET: "current-secret"
    }
    const requestBody = {
      source: {
        id: "session-digest:analytics",
        kind: "conversation",
        title: "Settled Jingler agent session",
        retrievedAt: "2026-08-01T00:00:00.000Z"
      },
      content: "Redacted settled outcome.",
      retrieval: { searches: 2, reads: 3, navigation: 1, graphReads: 4, proposals: 1 }
    }

    const ingested = await handleMemoryWorkerRequest(
      jsonRequest("org-analytics", "/internal/memory/sources", requestBody),
      env
    )
    expect(ingested.status).toBe(201)

    const dashboard = await handleMemoryWorkerRequest(
      getRequest("org-analytics", "/internal/memory/analytics?asOf=2026-08-01T01:00:00.000Z"),
      env
    )
    const body = await jsonBody(dashboard)
    expect(body).toMatchObject({
      retrieval: { searches: 2, reads: 3, navigation: 1, graphReads: 4, proposals: 1 }
    })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain("query")
    expect(serialized).not.toContain("Redacted settled outcome")
    expect(serialized).not.toContain("current-secret")
  })

  it("rejects malformed request bodies through the endpoint schema", async () => {
    const bucket = new InMemoryR2Bucket()
    const response = await handleMemoryWorkerRequest(
      new Request("https://memory.test/internal/memory/pages", {
        method: "POST",
        headers: {
          authorization: "Bearer current-secret",
          "content-type": "application/json",
          "x-jingler-organization-id": "org-a"
        },
        body: '{"revisionId":"revision-1"}'
      }),
      {
        MEMORY_R2: bucket,
        MEMORY_VAULTS: new TestVaultNamespace(bucket),
        MEMORY_SERVICE_SECRET: "current-secret"
      }
    )

    expect(response.status).toBe(400)
    expect(await jsonBody(response)).toMatchObject({ code: "invalid" })
  })

  it("redacts unexpected vault failures as internal errors", async () => {
    const bucket = new InMemoryR2Bucket()
    const unavailableVaults: DurableObjectNamespaceLike = {
      idFromName: (name) => new TestDurableObjectId(name),
      get: () => ({
        fetch: () => Promise.reject(new Error("private storage connection details"))
      })
    }
    const response = await handleMemoryWorkerRequest(
      getRequest("org-a", "/internal/memory/pages"),
      {
        MEMORY_R2: bucket,
        MEMORY_VAULTS: unavailableVaults,
        MEMORY_SERVICE_SECRET: "current-secret"
      }
    )

    expect(response.status).toBe(500)
    expect(await jsonBody(response)).toEqual({
      error: "memory service failed",
      code: "internal_error"
    })
  })

  it("keeps public workflow handles scoped to the authenticated organization", async () => {
    const bucket = new InMemoryR2Bucket()
    const instances = new Map<string, WorkflowInstanceLike>()
    const compiler = {
      create: async ({ id }: { readonly id: string }) => {
        const instance = { id, status: async () => ({ status: "queued" }) }
        instances.set(id, instance)
        return instance
      },
      get: async (id: string) => {
        const instance = instances.get(id)
        if (instance === undefined) throw new Error("not found")
        return instance
      }
    }
    const env: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_SERVICE_SECRET: "current-secret",
      MEMORY_COMPILER: compiler
    }
    const workflowId = "compiler-shared-public-handle"
    const started = await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/workflows/compiler", {
        workflowId,
        sourceId: "source-a",
        requestedBy: "member-a",
        createdAt: "2026-08-01T00:00:00.000Z"
      }),
      env
    )
    expect(started.status).toBe(202)
    expect(await jsonBody(started)).toMatchObject({ workflowId })
    expect(
      (await handleMemoryWorkerRequest(
        getRequest("org-a", `/internal/memory/workflows/${workflowId}`),
        env
      )).status
    ).toBe(200)
    expect(
      (await handleMemoryWorkerRequest(
        getRequest("org-b", `/internal/memory/workflows/${workflowId}`),
        env
      )).status
    ).toBe(404)
    expect([...instances.keys()]).toHaveLength(1)
    expect([...instances.keys()][0]).toMatch(/^team-/)
  })

  it("maps queued/running compiler runs to their platform state, not pending_review", async () => {
    const bucket = new InMemoryR2Bucket()
    let workflowStatus = "queued"
    const instances = new Map<string, WorkflowInstanceLike>()
    const compiler = {
      create: async ({ id }: { readonly id: string }) => {
        const instance = { id, status: async () => ({ status: workflowStatus }) }
        instances.set(id, instance)
        return instance
      },
      get: async (id: string) => {
        const instance = instances.get(id)
        if (instance === undefined) throw new Error("not found")
        return instance
      }
    }
    const env: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_SERVICE_SECRET: "current-secret",
      MEMORY_COMPILER: compiler
    }
    const workflowId = "compiler-status-mapping"
    await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/workflows/compiler", {
        workflowId,
        sourceId: "source-a",
        requestedBy: "member-a",
        createdAt: "2026-08-01T00:00:00.000Z"
      }),
      env
    )
    const read = async (): Promise<{ readonly state: string; readonly result: Record<string, unknown> }> =>
      (await jsonBody(
        await handleMemoryWorkerRequest(
          getRequest("org-a", `/internal/memory/workflows/${workflowId}`),
          env
        )
      )) as { readonly state: string; readonly result: Record<string, unknown> }

    // Still queued → no proposal id exists yet, so NOT pending_review.
    const queued = await read()
    expect(queued.result.status).toBe("queued")
    expect(queued.result.proposalId).toBeUndefined()

    // Actively compiling → surfaced as running, still not pending_review.
    workflowStatus = "running"
    expect((await read()).result.status).toBe("running")

    // Parked on the review event ("waiting") → proposals persisted, now reviewable.
    workflowStatus = "waiting"
    const waiting = await read()
    expect(waiting.result.status).toBe("pending_review")
    expect(waiting.result.proposalId).toBe(`proposal:${workflowId}`)
  })

  it("does not report a compiler workflow when instance creation actually failed", async () => {
    const bucket = new InMemoryR2Bucket()
    const env: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_SERVICE_SECRET: "current-secret",
      MEMORY_COMPILER: {
        create: async () => { throw new Error("binding unavailable") },
        get: async () => { throw new Error("instance absent") }
      }
    }
    const response = await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/sources", {
        source,
        content: "A valid source that should start compilation."
      }),
      env
    )
    expect(response.status).toBe(500)
    expect(await jsonBody(response)).toEqual({ error: "memory service failed", code: "internal_error" })
  })

  it("auto-publishes agent updates and leaves no review behind on success or conflict", async () => {
    const bucket = new InMemoryR2Bucket()
    const env: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_SERVICE_SECRET: "current-secret"
    }
    await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/sources", {
        source,
        content: "A stable cited source for the accepted page."
      }),
      env
    )
    await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/pages", {
        revisionId: "revision-agent-1",
        markdown: serializeMemoryMarkdown(page("agent", 1)),
        actorId: "agent-author",
        createdAt: "2026-08-01T00:00:00.000Z"
      }),
      env
    )

    const published = await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/proposals/auto-publish", {
        id: "proposal-agent-update",
        pageId: "shared-slug",
        baseRevisionId: "revision-agent-1",
        markdown: serializeMemoryMarkdown(page("agent-updated", 2)),
        proposedBy: "agent-author",
        createdAt: "2026-08-02T00:00:00.000Z",
        reviewerId: "system:memory-agent",
        acceptedAt: "2026-08-02T00:00:00.000Z"
      }),
      env
    )

    expect(await jsonBody(published)).toMatchObject({
      status: "accepted",
      proposalId: "proposal-agent-update",
      revisionId: "revision:proposal-agent-update",
      revision: 2
    })
    const detail = await handleMemoryWorkerRequest(
      getRequest("org-a", "/internal/memory/pages/shared-slug"),
      env
    )
    expect(await jsonBody(detail)).toMatchObject({ page: { revision: 2 } })
    const reviews = await handleMemoryWorkerRequest(
      getRequest("org-a", "/internal/memory/reviews?limit=100"),
      env
    )
    expect(await jsonBody(reviews)).toEqual({ reviews: [] })
    const proposal = await handleMemoryWorkerRequest(
      getRequest("org-a", "/internal/memory/proposals/proposal-agent-update"),
      env
    )
    expect(await jsonBody(proposal)).toMatchObject({ status: "accepted" })

    const stale = await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/proposals/auto-publish", {
        id: "proposal-agent-stale",
        pageId: "shared-slug",
        baseRevisionId: "revision-agent-1",
        markdown: serializeMemoryMarkdown(page("agent-stale", 2)),
        proposedBy: "agent-author",
        createdAt: "2026-08-03T00:00:00.000Z",
        reviewerId: "system:memory-agent",
        acceptedAt: "2026-08-03T00:00:00.000Z"
      }),
      env
    )
    expect(stale.status).toBe(409)
    expect(await jsonBody(stale)).toMatchObject({ code: "conflict" })
    const reviewsAfterConflict = await handleMemoryWorkerRequest(
      getRequest("org-a", "/internal/memory/reviews?limit=100"),
      env
    )
    expect(await jsonBody(reviewsAfterConflict)).toEqual({ reviews: [] })
    const staleProposal = await handleMemoryWorkerRequest(
      getRequest("org-a", "/internal/memory/proposals/proposal-agent-stale"),
      env
    )
    expect(staleProposal.status).toBe(404)
  })

  it("retries auto-publication after approval fails and accepts restamped replays", async () => {
    const bucket = new FailNextRevisionPutBucket()
    const env: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_SERVICE_SECRET: "current-secret"
    }
    await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/sources", {
        source,
        content: "A stable cited source for the accepted page."
      }),
      env
    )
    await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/pages", {
        revisionId: "revision-retry-1",
        markdown: serializeMemoryMarkdown(page("retry", 1)),
        actorId: "agent-author",
        createdAt: "2026-08-01T00:00:00.000Z"
      }),
      env
    )

    const proposal = {
      id: "proposal-agent-retry",
      pageId: "shared-slug",
      baseRevisionId: "revision-retry-1",
      markdown: serializeMemoryMarkdown(page("retry-updated", 2)),
      proposedBy: "agent-author",
      reviewerId: "system:memory-agent"
    }
    bucket.failNextRevisionPutForTest()
    const interrupted = await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/proposals/auto-publish", {
        ...proposal,
        createdAt: "2026-08-02T00:00:00.000Z",
        acceptedAt: "2026-08-02T00:00:00.000Z"
      }),
      env
    )
    expect(interrupted.status).toBe(500)
    expect(await jsonBody(interrupted)).toEqual({
      error: "memory service failed",
      code: "internal_error"
    })
    const openProposal = await handleMemoryWorkerRequest(
      getRequest("org-a", "/internal/memory/proposals/proposal-agent-retry"),
      env
    )
    expect(await jsonBody(openProposal)).toMatchObject({ status: "open" })

    const retried = await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/proposals/auto-publish", {
        ...proposal,
        createdAt: "2026-08-02T00:01:00.000Z",
        acceptedAt: "2026-08-02T00:01:00.000Z"
      }),
      env
    )
    expect(retried.status).toBe(200)
    const accepted = await jsonBody(retried)
    expect(accepted).toMatchObject({
      status: "accepted",
      proposalId: "proposal-agent-retry",
      revisionId: "revision:proposal-agent-retry",
      revision: 2
    })

    const replayed = await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/proposals/auto-publish", {
        ...proposal,
        createdAt: "2026-08-02T00:02:00.000Z",
        acceptedAt: "2026-08-02T00:02:00.000Z"
      }),
      env
    )
    expect(replayed.status).toBe(200)
    expect(await jsonBody(replayed)).toEqual(accepted)
    const snapshot = await handleMemoryWorkerRequest(
      getRequest("org-a", "/internal/memory/proposals/proposal-agent-retry"),
      env
    )
    expect(await jsonBody(snapshot)).toMatchObject({
      status: "accepted",
      createdAt: "2026-08-02T00:00:00.000Z"
    })
  })

  it("isolates identical page slugs across reads, search, lists, aggregates, and mutations", async () => {
    const bucket = new InMemoryR2Bucket()
    const env: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_SERVICE_SECRET: "current-secret",
      MEMORY_SERVICE_SECRET_PREVIOUS: "previous-secret"
    }

    for (const organizationId of ["org-a", "org-b"]) {
      expect(
        (
          await handleMemoryWorkerRequest(
            jsonRequest(organizationId, "/internal/memory/sources", {
              source,
              content: `private source for ${organizationId}`
            }),
            env
          )
        ).status
      ).toBe(201)
      const accepted = await handleMemoryWorkerRequest(
        jsonRequest(organizationId, "/internal/memory/pages", {
          revisionId: `${organizationId}-revision-1`,
          markdown: serializeMemoryMarkdown(page(organizationId)),
          actorId: `${organizationId}-author`,
          createdAt: "2026-07-01T00:00:00.000Z"
        }),
        env
      )
      expect(accepted.status).toBe(201)
      expect(await jsonBody(accepted)).toMatchObject({
        page: { id: "shared-slug", revision: 1 },
        revision: { id: `${organizationId}-revision-1`, pageId: "shared-slug" },
        sourceIds: ["source-stable"],
        citationIds: ["citation-stable"]
      })
    }

    const searchA = await handleMemoryWorkerRequest(
      getRequest("org-a", "/internal/memory/search?q=private-org-a&occurredAt=2026-08-01T00:00:00.000Z"),
      env
    )
    const searchB = await handleMemoryWorkerRequest(
      getRequest("org-b", "/internal/memory/search?q=private-org-a&occurredAt=2026-08-01T00:00:00.000Z"),
      env
    )
    expect(await jsonBody(searchA)).toMatchObject({
      total: 1,
      results: [{ pageId: "shared-slug", revisionId: "org-a-revision-1" }]
    })
    expect(await jsonBody(searchB)).toMatchObject({ total: 0, results: [] })

    for (const organizationId of ["org-a", "org-b"]) {
      const list = await handleMemoryWorkerRequest(
        getRequest(organizationId, "/internal/memory/pages"),
        env
      )
      expect(await jsonBody(list)).toMatchObject({ pages: [{ pageId: "shared-slug" }] })
      const analytics = await handleMemoryWorkerRequest(
        getRequest(organizationId, "/internal/memory/analytics?asOf=2026-08-01T00:00:00.000Z"),
        env
      )
      expect(await jsonBody(analytics)).toMatchObject({
        growth: { acceptedPages: 1, sources: 1 },
        retrieval: { searches: 1, resultsReturned: organizationId === "org-a" ? 1 : 0 }
      })
      const sourceList = await handleMemoryWorkerRequest(
        getRequest(organizationId, "/internal/memory/sources"),
        env
      )
      expect(await jsonBody(sourceList)).toMatchObject({ sources: [{ id: "source-stable" }] })
      const sourceRead = await handleMemoryWorkerRequest(
        getRequest(organizationId, "/internal/memory/sources/source-stable"),
        env
      )
      expect(await jsonBody(sourceRead)).toMatchObject({
        source: { id: "source-stable" },
        content: `private source for ${organizationId}`
      })
    }

    const proposal = await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/proposals", {
        id: "org-a-proposal",
        pageId: "shared-slug",
        baseRevisionId: "org-a-revision-1",
        markdown: serializeMemoryMarkdown(page("org-a-updated", 2)),
        proposedBy: "org-a-author",
        createdAt: "2026-07-02T00:00:00.000Z"
      }),
      env
    )
    expect(proposal.status).toBe(201)
    expect(
      (
        await handleMemoryWorkerRequest(
          getRequest("org-b", "/internal/memory/workflows/org-a-proposal"),
          env
        )
      ).status
    ).toBe(404)
    const approval = await handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/proposals/org-a-proposal/approve", {
        reviewerId: "reviewer",
        acceptedAt: "2026-07-03T00:00:00.000Z"
      }),
      env
    )
    expect(await jsonBody(approval)).toMatchObject({
      status: "accepted",
      proposalId: "org-a-proposal",
      revisionId: "revision:org-a-proposal"
    })
    expect(
      await jsonBody(
        await handleMemoryWorkerRequest(
          getRequest("org-b", "/internal/memory/pages/shared-slug"),
          env
        )
      )
    ).toMatchObject({ page: { revision: 1 }, revision: { id: "org-b-revision-1" } })

    expect(bucket.keys().some((key) => key.startsWith(organizationPrefix("org-a")))).toBe(true)
    expect(bucket.keys().some((key) => key.startsWith(organizationPrefix("org-b")))).toBe(true)
    expect(
      bucket.keys().every(
        (key) =>
          key.startsWith(organizationPrefix("org-a")) || key.startsWith(organizationPrefix("org-b"))
      )
    ).toBe(true)
  })

  const ingestSource = (env: MemoryWorkerEnv): Promise<Response> =>
    handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/sources", {
        source,
        content: "A stable cited source for the accepted page."
      }),
      env
    )

  const ingestPage = (env: MemoryWorkerEnv): Promise<Response> =>
    handleMemoryWorkerRequest(
      jsonRequest("org-a", "/internal/memory/pages", {
        revisionId: "org-a-revision-1",
        markdown: serializeMemoryMarkdown(page("org-a")),
        actorId: "org-a-author",
        createdAt: "2026-07-01T00:00:00.000Z"
      }),
      env
    )

  it("triggers a durable vector-ingest run on accepted publication with a deterministic org-scoped id", async () => {
    const bucket = new InMemoryR2Bucket()
    const created: Array<{ readonly id: string; readonly params: VectorIngestWorkflowInput }> = []
    const vectorIngest: WorkflowBindingLike<VectorIngestWorkflowInput> = {
      create: async ({ id, params }) => {
        created.push({ id, params })
        return { id, status: async () => ({ status: "queued" }) }
      },
      get: async () => {
        throw new Error("instance absent")
      }
    }
    const env: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_SERVICE_SECRET: "current-secret",
      MEMORY_VECTOR_INGEST: vectorIngest
    }

    // A source ingest is NOT a head advance, so it must not trigger ingestion.
    expect((await ingestSource(env)).status).toBe(201)
    expect(created).toHaveLength(0)

    // The accepted page advances the head → exactly one ingest run.
    expect((await ingestPage(env)).status).toBe(201)
    expect(created).toHaveLength(1)
    expect(created[0]!.params).toEqual({ organizationId: "org-a" })
    expect(created[0]!.id).toMatch(/^team-/)
    expect(created[0]!.id).not.toContain("org-a")
  })

  it("still publishes when the vector-ingest trigger throws (best-effort)", async () => {
    const bucket = new InMemoryR2Bucket()
    const env: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_SERVICE_SECRET: "current-secret",
      MEMORY_VECTOR_INGEST: {
        create: async () => {
          throw new Error("vector-ingest binding unavailable")
        },
        get: async () => {
          throw new Error("vector-ingest instance absent")
        }
      }
    }

    expect((await ingestSource(env)).status).toBe(201)
    // The head advance commits and returns 201 even though the trigger threw.
    const accepted = await ingestPage(env)
    expect(accepted.status).toBe(201)
    expect(await jsonBody(accepted)).toMatchObject({
      page: { id: "shared-slug", revision: 1 },
      revision: { id: "org-a-revision-1" }
    })
  })
})
