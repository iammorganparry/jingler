import { Effect } from "effect"
import { INTERNAL_ROUTES } from "./internal-routes.js"
import { OffloadJobStore, makeOffloadJobStoreLayer } from "./offload-store.js"
import type { ManagedRuntimeEnv } from "./runtime-env.js"

const requiredCleanupFetch = async (
  request: () => Promise<Response>,
  operation: string
): Promise<void> => {
  let lastStatus: number | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: bounded retries serialize one cleanup mutation.
    const response = await request()
    if (response.ok) return
    lastStatus = response.status
    if (attempt < 2) {
      // biome-ignore lint/performance/noAwaitInLoops: bounded cleanup backoff avoids a retry burst.
      await new Promise((resolve) => setTimeout(resolve, 100 * (2 ** attempt)))
    }
  }
  throw new Error(`${operation} failed with HTTP ${lastStatus ?? "unknown"}`)
}

/** Idempotent terminal cleanup shared by Workflow settlement and direct cancellation. */
export const cleanupOffloadJob = async (
  env: ManagedRuntimeEnv,
  jobId: string
): Promise<void> => {
  const layer = makeOffloadJobStoreLayer(env.OFFLOAD_JOBS)
  const record = await Effect.runPromise(
    Effect.flatMap(OffloadJobStore, (store) => store.get(jobId)).pipe(
      Effect.provide(layer)
    )
  ).catch(() => null)
  if (record === null) return
  await Effect.runPromise(
    Effect.flatMap(OffloadJobStore, (store) => store.removeSnapshot(jobId)).pipe(
      Effect.provide(layer),
      Effect.catchAll(() => Effect.void)
    )
  )
  await Promise.all([
    requiredCleanupFetch(
      () => env.MANAGED_ACCOUNT.getByName(record.subject).fetch(
        INTERNAL_ROUTES.managedAccount.offloadUnregister,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subject: record.subject, jobId })
        }
      ),
      "Offload account-slot cleanup"
    ),
    requiredCleanupFetch(
      () => env.OFFLOAD_SANDBOX_LIFECYCLE.getByName(record.request.sessionId).fetch(
        INTERNAL_ROUTES.offloadLifecycle.touch,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            subject: record.subject,
            sessionId: record.request.sessionId
          })
        }
      ),
      "Offload sandbox-lease cleanup"
    )
  ])
}
