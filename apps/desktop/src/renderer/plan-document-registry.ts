import { createActor, type ActorRefFrom } from "xstate"
import {
  planDocumentMachine,
  type PlanDocumentInput
} from "./plan-document-machine.js"
import { lruKeysToEvict } from "./registry-eviction.js"

export type PlanDocumentActor = ActorRefFrom<typeof planDocumentMachine>

const actors = new Map<string, PlanDocumentActor>()

const ownerKey = (sessionId: string, chatId: string): string => `${sessionId}:${chatId}`

/**
 * How many mounted `usePlanDocument` hooks reference each session's actor. Only
 * the (visible) conversation pane consumes a plan actor, so this reaches zero
 * exactly when the session goes off-screen. Background plan-tab presence is NOT
 * sourced from here — it is derived from the conversation actor's messages in
 * `conversation-registry.recomputeSession` — so evicting an unmounted plan actor
 * stales no surface; it reloads from `Plan.watch` when the pane returns.
 */
const mounts = new Map<string, number>()

/**
 * How many actors stay resident, matching the conversation registry's cap. Plan
 * documents are small, but the actor also holds a live `Plan.watch` stream, and
 * one per session the operator ever opened is the same unbounded retention the
 * conversation and file-browser registries cap.
 */
export const MAX_PLAN_DOCUMENT_ACTORS = 6

/** Drop the least-recently-used unmounted actors once residency exceeds the cap. */
const evictPlanDocumentActors = (keep: string): void => {
  // `actors` insertion order IS recency order — `getPlanDocumentActor` re-inserts
  // on every hit — so iterating it yields the LRU-first list the policy wants.
  // The plan is read-only, so the only thing worth pinning for is a live mount.
  const candidates = [...actors.keys()].map((sessionId) => ({
    key: sessionId,
    pinned: (mounts.get(sessionId) ?? 0) > 0
  }))
  for (const key of lruKeysToEvict(candidates, { keep, max: MAX_PLAN_DOCUMENT_ACTORS })) {
    const actor = actors.get(key)
    if (actor === undefined) continue
    actors.delete(key)
    actor.stop()
  }
}

/**
 * Plan documents are session resources, not view resources. Keeping their actors
 * here lets the loaded document and its `Plan.watch` subscription survive tab
 * changes and pane remounts. Residency is capped, so an actor for a session left
 * alone long enough may have been evicted — this rebuilds it, reloading from
 * `Plan.watch`, exactly as on a cold start.
 */
export const getPlanDocumentActor = (
  sessionId: string,
  chatId: string,
  input: PlanDocumentInput
): PlanDocumentActor => {
  const key = ownerKey(sessionId, chatId)
  const existing = actors.get(key)
  if (existing !== undefined) {
    // Re-insert to move this key to the most-recently-used end (see
    // `evictPlanDocumentActors`): `set` on an existing key leaves its position,
    // so without the delete the policy would read creation order.
    actors.delete(key)
    actors.set(key, existing)
    return existing
  }
  const actor = createActor(planDocumentMachine, { input })
  actor.start()
  actors.set(key, actor)
  evictPlanDocumentActors(key)
  return actor
}

/** Ref-count a mounted hook onto its session's actor; released on unmount. */
export const retainPlanDocumentActor = (sessionId: string, chatId: string): void => {
  const key = ownerKey(sessionId, chatId)
  mounts.set(key, (mounts.get(key) ?? 0) + 1)
}

export const releasePlanDocumentActor = (sessionId: string, chatId: string): void => {
  const key = ownerKey(sessionId, chatId)
  const next = (mounts.get(key) ?? 0) - 1
  if (next <= 0) mounts.delete(key)
  else mounts.set(key, next)
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
  for (const [key, actor] of actors) {
    if (!key.startsWith(`${sessionId}:`)) continue
    mounts.delete(key)
    actors.delete(key)
    actor.stop()
  }
}

/** Install the main-process close handshake once, before React mounts. */
export const installPlanDocumentFlushHandler = (): (() => void) =>
  window.jingler.onPlanFlushRequested(() => {
    void flushAllPlanDocuments().finally(() => {
      window.jingler.planFlushComplete()
    })
  })
