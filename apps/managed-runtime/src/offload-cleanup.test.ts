import type { OffloadAdmissionRequest } from "@jingler/core"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { cleanupOffloadJob } from "./offload-cleanup.js"
import { OffloadJobStore, makeOffloadJobStoreLayer } from "./offload-store.js"

class MemoryBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; etag: string }>()
  #version = 0
  async get(key: string) {
    const object = this.objects.get(key)
    return object === undefined ? null : {
      etag: object.etag,
      json: async () => JSON.parse(new TextDecoder().decode(object.bytes)),
      arrayBuffer: async () => object.bytes.slice().buffer
    }
  }
  async put(key: string, value: string | Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
    const current = this.objects.get(key)
    if (options?.onlyIf?.etagMatches !== undefined && current?.etag !== options.onlyIf.etagMatches) return null
    if (options?.onlyIf?.etagDoesNotMatch === "*" && current !== undefined) return null
    const object = {
      bytes: typeof value === "string" ? new TextEncoder().encode(value) : value,
      etag: `etag-${++this.#version}`
    }
    this.objects.set(key, object)
    return object
  }
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key)
  }
}

const request: OffloadAdmissionRequest = {
  version: 1,
  sessionId: "session_aaaaaaaaaaaaaaaa",
  idempotencyKey: "request_aaaaaaaaaaaaaaaa",
  repositorySlug: "jingler/example",
  snapshot: { version: 1, headSha: "a".repeat(40), digest: "b".repeat(64), bytes: 128 },
  command: {
    source: { kind: "preset", preset: "test" },
    executable: "pnpm",
    args: ["test"],
    cwd: "."
  },
  limits: { timeoutSeconds: 60, snapshotBytes: 128, outputBytes: 1024 }
}

describe("offload terminal cleanup", () => {
  it("removes the snapshot and unregisters the account slot idempotently", async () => {
    const bucket = new MemoryBucket()
    const layer = makeOffloadJobStoreLayer(bucket as unknown as R2Bucket)
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* OffloadJobStore
      yield* store.create({
        jobId: "job_aaaaaaaaaaaaaaaa",
        subject: "user_one",
        request,
        githubCapabilityHandle: "github_aaaaaaaaaaaaaaaa",
        nowSeconds: 1
      })
      yield* store.putSnapshot("job_aaaaaaaaaaaaaaaa", new Uint8Array([1]), request.snapshot.digest)
    }).pipe(Effect.provide(layer)))
    const accountFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true })
    )
    const lifecycleFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true })
    )
    const environment = {
      OFFLOAD_JOBS: bucket as unknown as R2Bucket,
      MANAGED_ACCOUNT: { getByName: () => ({ fetch: accountFetch }) },
      OFFLOAD_SANDBOX_LIFECYCLE: { getByName: () => ({ fetch: lifecycleFetch }) }
    }
    await cleanupOffloadJob(environment as never, "job_aaaaaaaaaaaaaaaa")
    await cleanupOffloadJob(environment as never, "job_aaaaaaaaaaaaaaaa")
    expect([...bucket.objects.keys()].some((key) => key.includes("/snapshots/"))).toBe(false)
    expect(accountFetch).toHaveBeenCalledTimes(2)
    expect(String(accountFetch.mock.calls[0]?.[0])).toContain("/v1/offload/unregister")
  })
})
