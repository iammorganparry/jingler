import { createActor, type ActorRefFrom } from "xstate"
import {
  planDocumentMachine,
  type PlanDocumentInput
} from "./plan-document-machine.js"

export type PlanDocumentActor = ActorRefFrom<typeof planDocumentMachine>

const actors = new Map<string, PlanDocumentActor>()

/**
 * Plan documents are session resources, not view resources. Keeping their actors
 * here lets the loaded document and its `Plan.watch` subscription survive tab
 * changes and pane remounts.
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

/**
 * The plan is read-only: there is no local draft to persist, so a flush is a
 * no-op. The handshake is retained so the main-process close contract still gets
 * its acknowledgement, and so callers do not have to special-case plans.
 */
export const flushPlanDocumentActor = (_actor: PlanDocumentActor): Promise<void> =>
  Promise.resolve()

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
