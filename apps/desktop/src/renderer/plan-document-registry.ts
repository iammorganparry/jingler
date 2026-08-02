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

// A flush is a no-op (the plan is read-only), so both wrappers just resolve. They
// exist so the close handshake and per-session callers don't special-case plans;
// if a real draft ever needs persisting, thread the failure handling in here.
export const flushPlanDocument = (_sessionId: string): Promise<void> => Promise.resolve()

export const flushAllPlanDocuments = (): Promise<void> => Promise.resolve()

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
