import type { OffloadAdmissionRequest, OffloadJobResult } from "@jingler/core"
import { Cause, Effect, Exit, Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  OffloadJobStore,
  makeOffloadJobStoreLayer,
  type OffloadJobStoreShape
} from "./offload-store.js"

class MemoryBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string>; etag: string }>()
  #version = 0

  async get(key: string) {
    const object = this.objects.get(key)
    if (!object) return null
    return {
      customMetadata: object.customMetadata,
      etag: object.etag,
      json: async () => JSON.parse(new TextDecoder().decode(object.bytes)),
      arrayBuffer: async () => object.bytes.slice().buffer
    }
  }

  async put(
    key: string,
    value: string | Uint8Array,
    options?: {
      customMetadata?: Record<string, string>
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }
    }
  ) {
    const existing = this.objects.get(key)
    if (
      options?.onlyIf?.etagMatches !== undefined &&
      existing?.etag !== options.onlyIf.etagMatches
    ) return null
    if (
      options?.onlyIf?.etagDoesNotMatch === "*" &&
      existing !== undefined
    ) return null
    const stored = {
      bytes: typeof value === "string" ? new TextEncoder().encode(value) : value,
      customMetadata: options?.customMetadata,
      etag: `etag-${++this.#version}`
    }
    this.objects.set(key, stored)
    return stored
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
  snapshot: {
    version: 1,
    headSha: "a".repeat(40),
    digest: "b".repeat(64),
    bytes: 128
  },
  command: {
    source: { kind: "preset", preset: "lint" },
    executable: "pnpm",
    args: ["lint"],
    cwd: "."
  },
  limits: { timeoutSeconds: 60, snapshotBytes: 128, outputBytes: 1024 }
}

const result: OffloadJobResult = {
  version: 1,
  jobId: "job_aaaaaaaaaaaaaaaa",
  state: "succeeded",
  exitCode: 0,
  failureReason: null,
  stdout: "clean",
  stderr: "",
  outputTruncated: false,
  timings: { queuedMs: 1, snapshotMs: 2, hydrationMs: 3, dependencyMs: 4, commandMs: 5 }
}

const program = <A, E>(
  bucket: MemoryBucket,
  effect: Effect.Effect<A, E, OffloadJobStore>
) => Effect.runPromise(effect.pipe(
  Effect.provide(makeOffloadJobStoreLayer(bucket as unknown as R2Bucket))
))

const create = (store: OffloadJobStoreShape) => store.create({
  jobId: result.jobId,
  subject: "user_one",
  request,
  githubCapabilityHandle: "github_aaaaaaaaaaaaaaaa",
  nowSeconds: 1_900_000_000
})

describe("offload job store", () => {
  it("creates idempotently but rejects a changed scope", async () => {
    const bucket = new MemoryBucket()
    await program(bucket, Effect.gen(function* () {
      const store = yield* OffloadJobStore
      const first = yield* create(store)
      const duplicate = yield* create(store)
      expect(duplicate).toEqual(first)
    }))
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const store = yield* OffloadJobStore
        yield* store.create({
          jobId: result.jobId,
          subject: "user_two",
          request,
          githubCapabilityHandle: "github_bbbbbbbbbbbbbbbb",
          nowSeconds: 1_900_000_000
        })
      }).pipe(Effect.provide(makeOffloadJobStoreLayer(bucket as unknown as R2Bucket)))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrThrow(Cause.failureOption(exit.cause)).reason).toBe("conflict")
    }
    const payloadConflict = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const store = yield* OffloadJobStore
        yield* store.create({
          jobId: result.jobId,
          subject: "user_one",
          request: {
            ...request,
            command: { ...request.command, args: ["test"] }
          },
          githubCapabilityHandle: "github_aaaaaaaaaaaaaaaa",
          nowSeconds: 1_900_000_000
        })
      }).pipe(Effect.provide(makeOffloadJobStoreLayer(bucket as unknown as R2Bucket)))
    )
    expect(Exit.isFailure(payloadConflict)).toBe(true)
    if (Exit.isFailure(payloadConflict)) {
      expect(Option.getOrThrow(Cause.failureOption(payloadConflict.cause)).reason).toBe("conflict")
    }
  })

  it("persists snapshots and ordered resumable events", async () => {
    const bucket = new MemoryBucket()
    await program(bucket, Effect.gen(function* () {
      const store = yield* OffloadJobStore
      yield* create(store)
      yield* store.putSnapshot(result.jobId, new Uint8Array([1, 2, 3]), request.snapshot.digest)
      expect(yield* store.getSnapshot(result.jobId)).toEqual(new Uint8Array([1, 2, 3]))
      const preparing = yield* store.append(result.jobId, {
        kind: "state",
        state: "preparing"
      })
      const output = yield* store.append(result.jobId, {
        kind: "output",
        stream: "stdout",
        text: "checking"
      })
      expect([preparing.sequence, output.sequence]).toEqual([2, 3])
      const record = yield* store.get(result.jobId)
      expect(record.events.map((event) => event.sequence)).toEqual([1, 2, 3])
    }))
  })

  it("serializes concurrent leases and preserves concurrent cancellation", async () => {
    const bucket = new MemoryBucket()
    await program(bucket, Effect.gen(function* () {
      const store = yield* OffloadJobStore
      yield* create(store)
    }))
    const leases = await Promise.all([
      program(bucket, Effect.flatMap(OffloadJobStore, (store) => store.acquireExecution(result.jobId))),
      program(bucket, Effect.flatMap(OffloadJobStore, (store) => store.acquireExecution(result.jobId)))
    ])
    expect(leases.sort()).toEqual(["acquired", "running"])
    await Promise.all([
      program(bucket, Effect.flatMap(OffloadJobStore, (store) => store.requestCancel(result.jobId))),
      program(bucket, Effect.flatMap(OffloadJobStore, (store) =>
        store.append(result.jobId, { kind: "output", stream: "stdout", text: "kept" })
      ))
    ])
    const record = await program(bucket, Effect.flatMap(OffloadJobStore, (store) => store.get(result.jobId)))
    expect(record.cancelRequested).toBe(true)
    expect(record.events.some((event) => event.kind === "output" && event.text === "kept")).toBe(true)
  })

  it("leases execution once and settles the result idempotently", async () => {
    const bucket = new MemoryBucket()
    await program(bucket, Effect.gen(function* () {
      const store = yield* OffloadJobStore
      yield* create(store)
      expect(yield* store.acquireExecution(result.jobId)).toBe("acquired")
      expect(yield* store.acquireExecution(result.jobId)).toBe("running")
      const settled = yield* store.finish(result.jobId, result)
      const duplicate = yield* store.finish(result.jobId, { ...result, stdout: "duplicate" })
      expect(settled.result).toEqual(result)
      expect(duplicate.result).toEqual(result)
      expect(yield* store.acquireExecution(result.jobId)).toBe("completed")
    }))
  })
})
