import type { OffloadAdmissionRequest } from "@jingler/core"
import type { WorkflowStep } from "cloudflare:workers"
import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  OffloadJobStore,
  makeOffloadJobStoreLayer
} from "./offload-store.js"

const sandboxFiles = new Map<string, string>()
const sandboxExec = vi.fn(async (command: string) => ({
  success: true,
  stdout: command.includes(" restore ") ? "d".repeat(64) : "",
  stderr: ""
}))
const sandbox = {
  exec: sandboxExec,
  writeFile: vi.fn(async (path: string, content: string) => {
    if (typeof content === "string") sandboxFiles.set(path, content)
    return {}
  }),
  readFile: vi.fn(async () => ({
    content: JSON.stringify({
      exitCode: 0,
      stdout: "typecheck clean",
      stderr: "",
      outputTruncated: false,
      timedOut: false,
      sourceMutated: false,
      commandMs: 25
    })
  }))
}

vi.mock("@cloudflare/sandbox", () => ({ getSandbox: () => sandbox }))
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }))

const { runOffloadWorkflow } = await import("./offload-workflow.js")

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>()
  async get(key: string) {
    const bytes = this.objects.get(key)
    return bytes === undefined ? null : {
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      arrayBuffer: async () => bytes.slice().buffer
    }
  }
  async put(key: string, value: string | Uint8Array) {
    this.objects.set(
      key,
      typeof value === "string" ? new TextEncoder().encode(value) : value
    )
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
    source: { kind: "preset", preset: "typecheck" },
    executable: "pnpm",
    args: ["typecheck"],
    cwd: "."
  },
  limits: { timeoutSeconds: 300, snapshotBytes: 128, outputBytes: 1024 }
}

const workflowStep = (): WorkflowStep => ({
  do: async (_name: string, configOrCallback: unknown, maybeCallback?: unknown) => {
    const callback = typeof configOrCallback === "function"
      ? configOrCallback
      : maybeCallback
    return (callback as () => Promise<unknown>)()
  },
  waitForEvent: async () => ({ payload: { jobId: "job_aaaaaaaaaaaaaaaa" } })
} as unknown as WorkflowStep)

const environment = (bucket: MemoryBucket) => ({
  OFFLOAD_JOBS: bucket as unknown as R2Bucket,
  MANAGED_RUNTIME_GRANT_SECRET: "workflow-signing-key-with-at-least-32-bytes",
  MANAGED_RUNTIME_ORIGIN: "https://managed-runtime.test",
  Sandbox: {},
  MANAGED_ACCOUNT: {
    getByName: () => ({ fetch: async () => Response.json({ ok: true }) })
  },
  OFFLOAD_SANDBOX_LIFECYCLE: {
    getByName: () => ({ fetch: async () => Response.json({ ok: true }) })
  }
})

const seed = async (bucket: MemoryBucket, cancelled = false) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* OffloadJobStore
      yield* store.create({
        jobId: "job_aaaaaaaaaaaaaaaa",
        subject: "user_one",
        request,
        githubCapabilityHandle: "github_aaaaaaaaaaaaaaaa",
        nowSeconds: Math.floor(Date.now() / 1_000)
      })
      yield* store.putSnapshot(
        "job_aaaaaaaaaaaaaaaa",
        new Uint8Array([1, 2, 3]),
        request.snapshot.digest
      )
      if (cancelled) yield* store.requestCancel("job_aaaaaaaaaaaaaaaa")
    }).pipe(
      Effect.provide(makeOffloadJobStoreLayer(bucket as unknown as R2Bucket))
    )
  )

beforeEach(() => {
  sandboxExec.mockClear()
  sandboxFiles.clear()
})

describe("offload workflow", () => {
  it("persists ordered resumable output and one terminal result", async () => {
    const bucket = new MemoryBucket()
    await seed(bucket)
    const result = await runOffloadWorkflow(
      environment(bucket) as never,
      { jobId: "job_aaaaaaaaaaaaaaaa" },
      workflowStep()
    )
    expect(result.state).toBe("succeeded")
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* OffloadJobStore
        return yield* store.get("job_aaaaaaaaaaaaaaaa")
      }).pipe(
        Effect.provide(makeOffloadJobStoreLayer(bucket as unknown as R2Bucket))
      )
    )
    expect(record.events.map((event) => event.sequence)).toEqual(
      [...record.events].map((_event, index) => index + 1)
    )
    expect(record.events.filter((event) => event.kind === "result")).toHaveLength(1)
    expect(record.events.some((event) => event.kind === "output")).toBe(true)
    expect([...bucket.objects.keys()].some((key) => key.includes("/snapshots/"))).toBe(false)
  })

  it("settles cancellation before sandbox execution", async () => {
    const bucket = new MemoryBucket()
    await seed(bucket, true)
    const result = await runOffloadWorkflow(
      environment(bucket) as never,
      { jobId: "job_aaaaaaaaaaaaaaaa" },
      workflowStep()
    )
    expect(result.state).toBe("cancelled")
    expect(sandboxExec).not.toHaveBeenCalled()
  })
})
