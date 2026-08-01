import { serializeMemoryMarkdown, type MemoryPage, type MemorySource } from "@jingler/memory"
import { describe, expect, it } from "vitest"
import { VAULT_ORGANIZATION_HEADER } from "./auth.js"
import { handleMemoryWorkerRequest, handleTeamVaultRequest } from "./api.js"
import type {
  DurableObjectIdLike,
  DurableObjectNamespaceLike,
  DurableObjectStubLike,
  MemoryWorkerEnv
} from "./env.js"
import { InMemoryR2Bucket, organizationPrefix } from "./r2-store.js"
import { memoryWorkerHealthResponse } from "./index.js"
import { InMemoryVaultState, TeamVault } from "./team-vault.js"

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
      vault = TeamVault.create(organizationId, new InMemoryVaultState(), this.bucket)
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

describe("memory Worker internal API", () => {
  it("reports binding readiness without exposing service credentials", async () => {
    const bucket = new InMemoryR2Bucket()
    const response = memoryWorkerHealthResponse({
      MEMORY_R2: bucket,
      MEMORY_VAULTS: new TestVaultNamespace(bucket),
      MEMORY_SERVICE_SECRET: "secret-that-must-not-escape"
    })
    expect(response.status).toBe(200)
    const body = JSON.stringify(await response.json())
    expect(body).toContain('"durableObjects":true')
    expect(body).toContain('"r2":true')
    expect(body).not.toContain("secret-that-must-not-escape")
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
    expect(await jsonBody(searchA)).toMatchObject({ total: 1, results: [{ pageId: "shared-slug" }] })
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
})
