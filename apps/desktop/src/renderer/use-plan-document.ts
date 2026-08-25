import type { PlanDocument } from "@jingler/core"
import type { PlanEditorSyncState } from "@jingler/ui"
import { useSelector } from "@xstate/react"
import { useCallback, useEffect, useMemo } from "react"
import {
  getPlanDocumentActor,
  releasePlanDocumentActor,
  retainPlanDocumentActor
} from "./plan-document-registry.js"
import { rpc } from "./rpc-client.js"

const listeners = new Map<string, Set<(document: PlanDocument | null) => void>>()
const ownerKey = (sessionId: string, chatId: string): string => `${sessionId}:${chatId}`
// One live `Plan.watch` stream per session, shared by all subscribers; the value
// is its stop handle. Replaces the previous fixed-interval `Plan.current` poll.
const watchers = new Map<string, () => void>()

const publish = (sessionId: string, chatId: string, document: PlanDocument | null): void => {
  for (const listener of listeners.get(ownerKey(sessionId, chatId)) ?? []) listener(document)
}

const subscribe = (
  sessionId: string,
  chatId: string,
  listener: (document: PlanDocument | null) => void
): (() => void) => {
  const key = ownerKey(sessionId, chatId)
  const existing = listeners.get(key) ?? new Set()
  existing.add(listener)
  listeners.set(key, existing)
  if (!watchers.has(key)) {
    // File-watch fires on the agent's writes AND external edits, and on the
    // first write that creates the plan (the watcher is on the directory).
    watchers.set(
      key,
      rpc.planWatch(sessionId, chatId, (document) => publish(sessionId, chatId, document))
    )
  }
  return () => {
    existing.delete(listener)
    if (existing.size > 0) return
    listeners.delete(key)
    const stop = watchers.get(key)
    if (stop !== undefined) {
      stop()
      watchers.delete(key)
    }
  }
}

export function usePlanDocument(sessionId: string, chatId: string) {
  const actor = useMemo(
    () => getPlanDocumentActor(sessionId, chatId, {
      sessionId,
      load: () => rpc.planCurrent(sessionId, chatId),
      subscribe: (listener) => subscribe(sessionId, chatId, listener)
    }),
    [sessionId, chatId]
  )
  // Pin this session's actor against eviction while the pane consuming it is mounted.
  useEffect(() => {
    retainPlanDocumentActor(sessionId, chatId)
    return () => releasePlanDocumentActor(sessionId, chatId)
  }, [sessionId, chatId])
  // Same no-op-emission filter as `useConversation`: only re-render when the
  // transition actually assigned new context or moved state. This hook feeds
  // `PlanProgressDock`/`PlanReview`, which sit beside the transcript — an
  // identity selector here re-rendered them on every actor event.
  const snapshot = useSelector(
    actor,
    (state) => state,
    (a, b) => a === b || (a.context === b.context && a.value === b.value)
  )

  // Create a blank draft from the template so the operator can start authoring a
  // plan for the agent before any run has proposed one. The created document
  // flows back through Plan.watch; publishing here just surfaces it immediately.
  const startDraft = useCallback(() => {
    void rpc
      .planStartDraft(sessionId, chatId)
      .then((document) => publish(sessionId, chatId, document))
      .catch(() => {})
  }, [sessionId, chatId])
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
