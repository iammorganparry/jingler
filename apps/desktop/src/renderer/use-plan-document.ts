import type { PlanDocument } from "@jingler/core"
import type { PlanEditorSyncState } from "@jingler/ui"
import { useSelector } from "@xstate/react"
import { useCallback, useMemo } from "react"
import { getPlanDocumentActor } from "./plan-document-registry.js"
import { rpc } from "./rpc-client.js"

const listeners = new Map<string, Set<(document: PlanDocument) => void>>()
// One live `Plan.watch` stream per session, shared by all subscribers; the value
// is its stop handle. Replaces the previous fixed-interval `Plan.current` poll.
const watchers = new Map<string, () => void>()

const publish = (sessionId: string, document: PlanDocument): void => {
  for (const listener of listeners.get(sessionId) ?? []) listener(document)
}

const subscribe = (
  sessionId: string,
  listener: (document: PlanDocument) => void
): (() => void) => {
  const existing = listeners.get(sessionId) ?? new Set()
  existing.add(listener)
  listeners.set(sessionId, existing)
  if (!watchers.has(sessionId)) {
    // File-watch fires on the agent's writes AND external edits, and on the
    // first write that creates the plan (the watcher is on the directory).
    watchers.set(
      sessionId,
      rpc.planWatch(sessionId, (document) => publish(sessionId, document))
    )
  }
  return () => {
    existing.delete(listener)
    if (existing.size > 0) return
    listeners.delete(sessionId)
    const stop = watchers.get(sessionId)
    if (stop !== undefined) {
      stop()
      watchers.delete(sessionId)
    }
  }
}

export function usePlanDocument(sessionId: string) {
  const actor = useMemo(
    () => getPlanDocumentActor(sessionId, {
      sessionId,
      load: () => rpc.planCurrent(sessionId),
      subscribe: (listener) => {
        return subscribe(sessionId, listener)
      }
    }),
    [sessionId]
  )
  const snapshot = useSelector(actor, (state) => state)

  // Create a blank draft from the template so the operator can start authoring a
  // plan for the agent before any run has proposed one. The created document
  // flows back through Plan.watch; publishing here just surfaces it immediately.
  const startDraft = useCallback(() => {
    void rpc
      .planStartDraft(sessionId)
      .then((document) => publish(sessionId, document))
      .catch(() => {})
  }, [sessionId])
  // Reload after a load failure; the plan is read-only, so there is no save to
  // retry — only the initial `Plan.current` fetch.
  const retry = useCallback(() => actor.send({ type: "RETRY" }), [actor])
  const beginRevision = useCallback(
    (stageId: string | null) => actor.send({ type: "REVISION_STARTED", stageId }),
    [actor]
  )

  // The plan document is read-only. Its only remaining sync states are the
  // initial load, the loaded/`clean` steady state (kept in step with remote
  // revisions), and a load error.
  const state: PlanEditorSyncState = snapshot.matches("loading")
    ? "loading"
    : snapshot.matches("error")
      ? "error"
      : "clean"

  return {
    document: snapshot.context.document,
    draft: snapshot.context.draft,
    error: snapshot.context.error,
    state,
    retry,
    beginRevision,
    revisionTarget: snapshot.context.revisionTarget,
    startDraft,
    synced: snapshot.matches("clean"),
    canApprove: snapshot.matches("clean") && snapshot.context.document !== null
  }
}
