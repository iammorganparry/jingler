import {
  OffloadAdmissionRequest,
  OffloadJobEvent,
  OffloadJobResult,
  type OffloadAdmissionRequest as OffloadAdmissionRequestValue,
  type OffloadJobEvent as OffloadJobEventValue,
  type OffloadJobResult as OffloadJobResultValue,
  type OffloadJobState
} from "@jingler/core"
import { Context, Data, Effect, Layer, Schema } from "effect"

const JOB_RETENTION_SECONDS = 24 * 60 * 60
const MAX_EVENTS = 1_024

export class OffloadStoreError extends Data.TaggedError("OffloadStoreError")<{
  readonly reason: "not-found" | "conflict" | "invalid" | "storage"
  readonly message: string
  readonly cause?: unknown
}> {}

export interface OffloadJobRecord {
  readonly version: 1
  readonly jobId: string
  readonly subject: string
  readonly request: OffloadAdmissionRequestValue
  readonly githubCapabilityHandle: string
  readonly state: OffloadJobState
  readonly sequence: number
  readonly events: ReadonlyArray<OffloadJobEventValue>
  readonly result: OffloadJobResultValue | null
  readonly cancelRequested: boolean
  readonly execution: "available" | "running" | "completed"
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt: number
}

export interface CreateOffloadJobInput {
  readonly jobId: string
  readonly subject: string
  readonly request: OffloadAdmissionRequestValue
  readonly githubCapabilityHandle: string
  readonly nowSeconds: number
}

export type OffloadAppendEvent =
  | { readonly kind: "state"; readonly state: OffloadJobState }
  | { readonly kind: "output"; readonly stream: "stdout" | "stderr"; readonly text: string }

export interface OffloadJobStoreShape {
  readonly create: (input: CreateOffloadJobInput) => Effect.Effect<OffloadJobRecord, OffloadStoreError>
  readonly get: (jobId: string) => Effect.Effect<OffloadJobRecord, OffloadStoreError>
  readonly putSnapshot: (
    jobId: string,
    bytes: Uint8Array,
    digest: string
  ) => Effect.Effect<void, OffloadStoreError>
  readonly getSnapshot: (jobId: string) => Effect.Effect<Uint8Array, OffloadStoreError>
  readonly removeSnapshot: (jobId: string) => Effect.Effect<void, OffloadStoreError>
  readonly append: (
    jobId: string,
    event: OffloadAppendEvent
  ) => Effect.Effect<OffloadJobEventValue, OffloadStoreError>
  readonly requestCancel: (jobId: string) => Effect.Effect<OffloadJobRecord, OffloadStoreError>
  readonly acquireExecution: (
    jobId: string
  ) => Effect.Effect<"acquired" | "running" | "completed", OffloadStoreError>
  readonly finish: (
    jobId: string,
    result: OffloadJobResultValue
  ) => Effect.Effect<OffloadJobRecord, OffloadStoreError>
  readonly remove: (jobId: string) => Effect.Effect<void, OffloadStoreError>
}

export class OffloadJobStore extends Context.Tag("@jingler/OffloadJobStore")<
  OffloadJobStore,
  OffloadJobStoreShape
>() {}

const jobKey = (jobId: string): string => `offload/jobs/${encodeURIComponent(jobId)}.json`
const snapshotKey = (jobId: string): string =>
  `offload/snapshots/${encodeURIComponent(jobId)}.json.gz`

const storageFailure = (message: string, cause?: unknown): OffloadStoreError =>
  new OffloadStoreError({ reason: "storage", message, cause })

const decodeRecord = (value: unknown): OffloadJobRecord => {
  const fields = typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : null
  const request = Schema.decodeUnknownSync(OffloadAdmissionRequest)(fields?.request, {
    onExcessProperty: "error"
  })
  const events = Schema.decodeUnknownSync(Schema.Array(OffloadJobEvent))(fields?.events)
  const result = fields?.result === null
    ? null
    : Schema.decodeUnknownSync(OffloadJobResult)(fields?.result, {
        onExcessProperty: "error"
      })
  if (
    fields?.version !== 1 ||
    typeof fields.jobId !== "string" ||
    typeof fields.subject !== "string" ||
    typeof fields.githubCapabilityHandle !== "string" ||
    typeof fields.state !== "string" ||
    typeof fields.sequence !== "number" ||
    typeof fields.cancelRequested !== "boolean" ||
    (fields.execution !== "available" && fields.execution !== "running" && fields.execution !== "completed") ||
    typeof fields.createdAt !== "number" ||
    typeof fields.updatedAt !== "number" ||
    typeof fields.expiresAt !== "number"
  ) {
    throw new Error("Invalid offload job record")
  }
  return {
    version: 1,
    jobId: fields.jobId,
    subject: fields.subject,
    request,
    githubCapabilityHandle: fields.githubCapabilityHandle,
    state: fields.state as OffloadJobState,
    sequence: fields.sequence,
    events,
    result,
    cancelRequested: fields.cancelRequested,
    execution: fields.execution,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
    expiresAt: fields.expiresAt
  }
}

export const makeOffloadJobStoreLayer = (bucket: R2Bucket): Layer.Layer<OffloadJobStore> => {
  const read = (jobId: string): Effect.Effect<OffloadJobRecord, OffloadStoreError> =>
    Effect.tryPromise({
      try: async () => {
        const object = await bucket.get(jobKey(jobId))
        if (object === null) {
          throw new OffloadStoreError({
            reason: "not-found",
            message: "Offload job was not found"
          })
        }
        return decodeRecord(await object.json())
      },
      catch: (cause) =>
        cause instanceof OffloadStoreError
          ? cause
          : storageFailure("Offload job could not be read", cause)
    })

  const write = (record: OffloadJobRecord): Effect.Effect<OffloadJobRecord, OffloadStoreError> =>
    Effect.tryPromise({
      try: async () => {
        await bucket.put(jobKey(record.jobId), JSON.stringify(record), {
          httpMetadata: { contentType: "application/json" },
          customMetadata: {
            expiresAt: String(record.expiresAt),
            state: record.state
          }
        })
        return record
      },
      catch: (cause) => storageFailure("Offload job could not be persisted", cause)
    })

  const update = (
    jobId: string,
    change: (current: OffloadJobRecord) => OffloadJobRecord
  ): Effect.Effect<OffloadJobRecord, OffloadStoreError> =>
    Effect.gen(function* () {
      const current = yield* read(jobId)
      return yield* write(change(current))
    })

  const service: OffloadJobStoreShape = {
    create: (input) =>
      Effect.gen(function* () {
        const existing = yield* read(input.jobId).pipe(
          Effect.catchTag("OffloadStoreError", (error) =>
            error.reason === "not-found" ? Effect.succeed(null) : Effect.fail(error)
          )
        )
        if (existing !== null) {
          if (
            existing.subject === input.subject &&
            existing.request.idempotencyKey === input.request.idempotencyKey &&
            existing.request.snapshot.digest === input.request.snapshot.digest
          ) return existing
          return yield* Effect.fail(new OffloadStoreError({
            reason: "conflict",
            message: "Offload job idempotency scope changed"
          }))
        }
        const event: OffloadJobEventValue = {
          version: 1,
          jobId: input.jobId,
          sequence: 1,
          kind: "state",
          state: "uploading"
        }
        return yield* write({
          version: 1,
          jobId: input.jobId,
          subject: input.subject,
          request: input.request,
          githubCapabilityHandle: input.githubCapabilityHandle,
          state: "uploading",
          sequence: 1,
          events: [event],
          result: null,
          cancelRequested: false,
          execution: "available",
          createdAt: input.nowSeconds,
          updatedAt: input.nowSeconds,
          expiresAt: input.nowSeconds + JOB_RETENTION_SECONDS
        })
      }),
    get: read,
    putSnapshot: (jobId, bytes, digest) =>
      Effect.tryPromise({
        try: async () => {
          await bucket.put(snapshotKey(jobId), bytes, {
            httpMetadata: { contentType: "application/vnd.jingler.offload-snapshot+gzip" },
            customMetadata: { digest }
          })
        },
        catch: (cause) => storageFailure("Offload snapshot could not be persisted", cause)
      }),
    getSnapshot: (jobId) =>
      Effect.tryPromise({
        try: async () => {
          const object = await bucket.get(snapshotKey(jobId))
          if (object === null) throw new OffloadStoreError({
            reason: "not-found",
            message: "Offload snapshot was not found"
          })
          return new Uint8Array(await object.arrayBuffer())
        },
        catch: (cause) =>
          cause instanceof OffloadStoreError
            ? cause
            : storageFailure("Offload snapshot could not be read", cause)
      }),
    removeSnapshot: (jobId) => Effect.tryPromise({
      try: () => bucket.delete(snapshotKey(jobId)),
      catch: (cause) => storageFailure("Offload snapshot cleanup failed", cause)
    }),
    append: (jobId, value) =>
      Effect.gen(function* () {
        let appended: OffloadJobEventValue | null = null
        yield* update(jobId, (current) => {
          const event = Schema.decodeUnknownSync(OffloadJobEvent)({
            ...value,
            version: 1,
            jobId,
            sequence: current.sequence + 1
          })
          appended = event
          return {
            ...current,
            state: event.kind === "state" ? event.state : current.state,
            sequence: event.sequence,
            events: [...current.events, event].slice(-MAX_EVENTS),
            updatedAt: Math.floor(Date.now() / 1_000)
          }
        })
        if (appended === null) return yield* Effect.fail(storageFailure("Event append failed"))
        return appended
      }),
    requestCancel: (jobId) => update(jobId, (current) => ({
      ...current,
      cancelRequested: true,
      state: current.result === null ? "cancelling" : current.state,
      updatedAt: Math.floor(Date.now() / 1_000)
    })),
    acquireExecution: (jobId) =>
      Effect.gen(function* () {
        let outcome: "acquired" | "running" | "completed" = "running"
        yield* update(jobId, (current) => {
          outcome = current.execution === "available" ? "acquired" : current.execution
          return current.execution === "available"
            ? { ...current, execution: "running" }
            : current
        })
        return outcome
      }),
    finish: (jobId, result) => update(jobId, (current) => {
      if (current.result !== null) return current
      const event: OffloadJobEventValue = {
        version: 1,
        jobId,
        sequence: current.sequence + 1,
        kind: "result",
        result
      }
      return {
        ...current,
        state: result.state,
        sequence: event.sequence,
        events: [...current.events, event].slice(-MAX_EVENTS),
        result,
        execution: "completed",
        updatedAt: Math.floor(Date.now() / 1_000)
      }
    }),
    remove: (jobId) => Effect.tryPromise({
      try: () => bucket.delete([jobKey(jobId), snapshotKey(jobId)]),
      catch: (cause) => storageFailure("Offload job cleanup failed", cause)
    })
  }
  return Layer.succeed(OffloadJobStore, service)
}
