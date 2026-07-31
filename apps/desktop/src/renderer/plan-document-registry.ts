import { createActor, type ActorRefFrom, type SnapshotFrom } from "xstate"
import {
  planDocumentMachine,
  type PlanDocumentInput
} from "./plan-document-machine.js"

export type PlanDocumentActor = ActorRefFrom<typeof planDocumentMachine>
type PlanDocumentSnapshot = SnapshotFrom<typeof planDocumentMachine>

const actors = new Map<string, PlanDocumentActor>()

/**
 * Plan editors are session resources, not view resources. Keeping their actors
 * here lets a pending debounce or save survive tab changes and pane remounts.
 */
export const getPlanDocumentActor = (
  sessionId: string,
  input: PlanDocumentInput
): PlanDocumentActor => {
  const existing = actors.get(sessionId)
  if (existing !== undefined) return existing
  const actor = createActor(planDocumentMachine, { input })
  actor.start()
  actors.set(sessionId, actor)
  return actor
}

const dirty = (snapshot: PlanDocumentSnapshot): boolean =>
  snapshot.context.document !== null &&
  snapshot.context.draft !== snapshot.context.document.source

/** Persist the newest draft, including one typed while an earlier save is in flight. */
export const flushPlanDocumentActor = (
  actor: PlanDocumentActor
): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false
    let retried = false
    let subscription: { unsubscribe: () => void } | null = null
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      subscription?.unsubscribe()
      if (error === undefined) resolve()
      else reject(error)
    }
    const inspect = (snapshot: PlanDocumentSnapshot) => {
      if (snapshot.matches("clean") && !dirty(snapshot)) {
        finish()
        return
      }
      if (snapshot.matches("editing")) {
        actor.send({ type: "SAVE_NOW" })
        return
      }
      if (snapshot.matches("error")) {
        if (!retried && dirty(snapshot)) {
          retried = true
          actor.send({ type: "RETRY" })
          return
        }
        finish(new Error(snapshot.context.error ?? "Plan draft could not be saved."))
        return
      }
      if (snapshot.matches("conflict")) {
        finish(new Error("Plan draft has an unresolved remote conflict."))
      }
    }
    subscription = actor.subscribe(inspect)
    inspect(actor.getSnapshot())
  })

export const flushPlanDocument = async (sessionId: string): Promise<void> => {
  const actor = actors.get(sessionId)
  if (actor !== undefined) await flushPlanDocumentActor(actor)
}

export const flushAllPlanDocuments = async (): Promise<void> => {
  const results = await Promise.allSettled(
    [...actors.values()].map(flushPlanDocumentActor)
  )
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more plan drafts could not be saved.")
  }
}

/** Stop a session actor only after its session has been permanently removed. */
export const stopPlanDocument = (sessionId: string): void => {
  const actor = actors.get(sessionId)
  if (actor === undefined) return
  actors.delete(sessionId)
  actor.stop()
}

/** Install the main-process close handshake once, before React mounts. */
export const installPlanDocumentFlushHandler = (): (() => void) =>
  window.jingler.onPlanFlushRequested(() => {
    void flushAllPlanDocuments().finally(() => {
      window.jingler.planFlushComplete()
    })
  })
