import { describe, expect, it } from "vitest"
import worker from "./index.js"
import type { MemoryWorkerEnv } from "./env.js"
import { InMemoryR2Bucket, listOrganizationIds } from "./r2-store.js"
import type { VectorIngestWorkflowInput } from "./workflows/vector-ingest.js"

const bucketWithVaults = (organizationIds: ReadonlyArray<string>): InMemoryR2Bucket => {
  const bucket = new InMemoryR2Bucket()
  for (const organizationId of organizationIds) {
    // A single object under the org prefix is enough to mark a vault as present.
    void bucket.put(`organizations/${encodeURIComponent(organizationId)}/history/latest.json`, "{}")
  }
  return bucket
}

describe("scheduled vector-ingest drift sweep", () => {
  it("discovers every organization with an R2 vault via delimited prefixes", async () => {
    const bucket = bucketWithVaults(["org-alpha", "org-beta", "team/with-slash"])
    // Non-org keys and deeper objects must not leak or duplicate an org.
    await bucket.put("organizations/org-alpha/pages/blobs/abc.md", "# body")
    await bucket.put("unrelated/key.json", "{}")
    expect(await listOrganizationIds(bucket)).toEqual(["org-alpha", "org-beta", "team/with-slash"])
  })

  it("sweeps an org that has a vault but never opted into lint", async () => {
    const bucket = bucketWithVaults(["vault-only-org"])
    const swept: Array<string> = []
    const vectorIngest = {
      create: async ({ params }: { readonly id: string; readonly params: VectorIngestWorkflowInput }) => {
        swept.push(params.organizationId)
        return { id: params.organizationId, status: async () => ({ status: "queued" }) }
      },
      get: async () => {
        throw new Error("instance absent")
      }
    }
    const env: MemoryWorkerEnv = {
      MEMORY_R2: bucket,
      MEMORY_VAULTS: {
        idFromName: (name) => ({ toString: () => name }),
        get: () => ({ fetch: async () => new Response(null) })
      },
      MEMORY_SERVICE_SECRET: "current-secret",
      MEMORY_VECTOR_INGEST: vectorIngest
      // Note: MEMORY_LINT and MEMORY_LINT_ORGANIZATIONS are BOTH unset — the org is
      // not opted into lint, yet it must still be reconciled.
    }
    await worker.scheduled({ scheduledTime: Date.parse("2026-08-02T00:00:00.000Z") }, env)
    expect(swept).toEqual(["vault-only-org"])
  })
})
