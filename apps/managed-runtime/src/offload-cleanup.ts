import { Effect } from "effect"
import { INTERNAL_ROUTES } from "./internal-routes.js"
import { OffloadJobStore, makeOffloadJobStoreLayer } from "./offload-store.js"
import type { ManagedRuntimeEnv } from "./runtime-env.js"

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
    env.MANAGED_ACCOUNT.getByName(record.subject).fetch(
      INTERNAL_ROUTES.managedAccount.offloadUnregister,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: record.subject, jobId })
      }
    ),
    env.OFFLOAD_SANDBOX_LIFECYCLE.getByName(record.request.sessionId).fetch(
      INTERNAL_ROUTES.offloadLifecycle.touch,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: record.subject,
          sessionId: record.request.sessionId
        })
      }
    )
  ]).catch(() => undefined)
}
