import type { MemoryPage } from "@jingler/memory"
import { describe, expect, it } from "vitest"
import { FakeEmbedder, type Embedder } from "../embeddings.js"
import type {
  DurableObjectNamespaceLike,
  MemoryWorkerEnv,
  WorkflowBindingLike,
  WorkflowInstanceLike
} from "../env.js"
import worker from "../index.js"
import { InMemoryR2Bucket } from "../r2-store.js"
import {
  InMemoryTurbopufferClient,
  TurbopufferVectorLayer,
  turbopufferNamespace
} from "../turbopuffer.js"
import type { WorkflowStepLike } from "./compiler.js"
import {
  runVectorIngestWorkflow,
  type VectorIngestRepository,
  type VectorIngestWorkflowInput
} from "./vector-ingest.js"

class ImmediateStep implements WorkflowStepLike {
  readonly names: Array<string> = []

  async do<Result>(name: string, callback: () => Promise<Result> | Result): Promise<Result> {
    this.names.push(name)
    return callback()
  }
}

/** Records how many texts it embedded, so unchanged re-runs can prove zero work. */
class CountingEmbedder implements Embedder {
  embedded = 0
  private readonly inner = new FakeEmbedder()
  readonly model = this.inner.model
  readonly dims = this.inner.dims

  async embed(texts: ReadonlyArray<string>): Promise<Array<Array<number>>> {
    this.embedded += texts.length
    return this.inner.embed(texts)
  }
}

const page = (id: string, body: string): MemoryPage => ({
  id,
  path: `${id}.md`,
  title: id,
  revision: 1,
  aliases: [],
  tags: [],
  sources: [],
  citations: [],
  relationships: [],
  body,
  metadata: {}
})

const repositoryOf = (pages: ReadonlyArray<MemoryPage>): VectorIngestRepository & { reads: number } => {
  const repo = {
    reads: 0,
    listAcceptedPages: async () => {
      repo.reads += 1
      return pages
    }
  }
  return repo
}

const organizationId = "org-vectors"
const namespace = turbopufferNamespace(organizationId)

describe("durable memory vector-ingest workflow", () => {
  it("embeds and upserts explicit vectors for accepted pages", async () => {
    const client = new InMemoryTurbopufferClient()
    const embedder = new CountingEmbedder()
    const layer = new TurbopufferVectorLayer(client, organizationId, embedder)
    const step = new ImmediateStep()

    const result = await runVectorIngestWorkflow(
      { organizationId },
      repositoryOf([page("a", "raised garden beds"), page("b", "tcp congestion window")]),
      layer,
      step
    )

    expect(step.names).toEqual(["01-load-accepted-pages", "02-reconcile-turbopuffer-namespace"])
    expect(result.status).toBe("reconciled")
    if (result.status !== "reconciled") throw new Error("expected reconciled")
    expect(result.summary).toMatchObject({ embedded: 2, upserted: 2, deleted: 0, unchanged: 0 })
    expect(embedder.embedded).toBe(2)
    const heads = await client.heads(namespace)
    expect(heads.map((head) => head.id).sort()).toEqual(["a", "b"])
  })

  it("skips unchanged pages and is safe to re-run (idempotent)", async () => {
    const client = new InMemoryTurbopufferClient()
    const embedder = new CountingEmbedder()
    const layer = new TurbopufferVectorLayer(client, organizationId, embedder)
    const pages = [page("a", "raised garden beds"), page("b", "tcp congestion window")]

    await runVectorIngestWorkflow({ organizationId }, repositoryOf(pages), layer, new ImmediateStep())
    const embeddedAfterFirst = embedder.embedded

    const rerun = await runVectorIngestWorkflow(
      { organizationId },
      repositoryOf(pages),
      layer,
      new ImmediateStep()
    )

    if (rerun.status !== "reconciled") throw new Error("expected reconciled")
    // Re-running against an unchanged accepted set embeds and upserts nothing.
    expect(rerun.summary).toMatchObject({ embedded: 0, upserted: 0, deleted: 0, unchanged: 2 })
    expect(embedder.embedded).toBe(embeddedAfterFirst)
  })

  it("re-embeds changed pages and deletes removed ones", async () => {
    const client = new InMemoryTurbopufferClient()
    const layer = new TurbopufferVectorLayer(client, organizationId, new CountingEmbedder())

    await runVectorIngestWorkflow(
      { organizationId },
      repositoryOf([page("a", "original body"), page("b", "to be removed")]),
      layer,
      new ImmediateStep()
    )

    const next = await runVectorIngestWorkflow(
      { organizationId },
      // "a" body changed, "b" removed, "c" added.
      repositoryOf([page("a", "rewritten body"), page("c", "freshly added")]),
      layer,
      new ImmediateStep()
    )

    if (next.status !== "reconciled") throw new Error("expected reconciled")
    expect(next.summary).toMatchObject({ embedded: 2, upserted: 2, deleted: 1, unchanged: 0 })
    const heads = await client.heads(namespace)
    expect(heads.map((head) => head.id).sort()).toEqual(["a", "c"])
  })

  it("is a clean no-op when the vector layer is inactive", async () => {
    const step = new ImmediateStep()
    const repo = repositoryOf([page("a", "body")])

    const result = await runVectorIngestWorkflow({ organizationId }, repo, undefined, step)

    expect(result).toEqual({
      status: "skipped",
      organizationId,
      reason: "vector-layer-inactive"
    })
    // No accepted-page read, no steps: nothing to reconcile without a layer.
    expect(step.names).toEqual([])
    expect(repo.reads).toBe(0)
  })

  it("starts deterministic per-organization vector-ingest sweeps on the cron", async () => {
    const created: Array<string> = []
    const instances = new Map<string, WorkflowInstanceLike>()
    const vectorIngest: WorkflowBindingLike<VectorIngestWorkflowInput> = {
      create: async ({ id }) => {
        const existing = instances.get(id)
        if (existing !== undefined) return existing
        const instance: WorkflowInstanceLike = { id, status: async () => ({ status: "queued" }) }
        instances.set(id, instance)
        created.push(id)
        return instance
      },
      get: async (id) => {
        const instance = instances.get(id)
        if (instance === undefined) throw new Error("workflow not found")
        return instance
      }
    }
    const noopNamespace: DurableObjectNamespaceLike = {
      idFromName: (name) => ({ name, toString: () => name }),
      get: () => ({ fetch: async () => new Response(null, { status: 404 }) })
    }
    const env: MemoryWorkerEnv = {
      MEMORY_R2: new InMemoryR2Bucket(),
      MEMORY_VAULTS: noopNamespace,
      MEMORY_SERVICE_SECRET: "test-service-secret",
      MEMORY_VECTOR_INGEST: vectorIngest,
      MEMORY_LINT_ORGANIZATIONS: "org-b, org-a, org-a"
    }
    const event = { scheduledTime: Date.parse("2026-08-01T03:17:00.000Z") }
    await worker.scheduled(event, env)
    await worker.scheduled(event, env)

    // Two distinct orgs → two opaque, org-hashed ids; the repeated cron dedupes.
    expect(created).toHaveLength(2)
    expect(new Set(created).size).toBe(2)
    expect(created.every((id) => id.startsWith("team-") && !id.includes("org-"))).toBe(true)
  })
})
