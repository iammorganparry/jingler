import {
  appendPlanAnnotationSource,
  type PlanAcceptanceStatus,
  type PlanDocument,
  updatePlanCriterionSource
} from "@jingler/core"
import type { PlanEditorSyncState } from "@jingler/ui"
import { useMachine } from "@xstate/react"
import { useCallback } from "react"
import { planDocumentMachine } from "./plan-document-machine.js"
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
  const [snapshot, send] = useMachine(planDocumentMachine, {
    input: {
      sessionId,
      load: () => rpc.planCurrent(sessionId),
      save: async ({ document, source }) => {
        let saved: PlanDocument
        try {
          saved = await rpc.planUpdateDocument({
            sessionId,
            planId: document.id,
            baseRevision: document.revision,
            source,
            author: "user"
          })
        } catch (error) {
          // Effect RPC preserves the typed failure in most transports, but
          // Electron can surface only the squashed Error. Re-read once so a
          // compare-and-swap refusal never degrades into a generic save error
          // or lets the next poll silently replace the operator's local draft.
          const latest = await rpc.planCurrent(sessionId).catch(() => null)
          if (
            latest !== null &&
            (latest.id !== document.id || latest.revision !== document.revision)
          ) {
            throw {
              message: "The canonical plan changed while this draft was being edited.",
              latest
            }
          }
          throw error
        }
        // Let this machine consume its save result before peers receive the
        // broadcast; otherwise its own revision looks like a remote collision.
        setTimeout(() => publish(sessionId, saved), 0)
        return saved
      },
      subscribe: (listener) => {
        return subscribe(sessionId, listener)
      }
    }
  })

  // Create a blank draft from the template so the operator can start authoring a
  // plan for the agent before any run has proposed one. The created document
  // flows back through Plan.watch; publishing here just surfaces it immediately.
  const startDraft = useCallback(() => {
    void rpc
      .planStartDraft(sessionId)
      .then((document) => publish(sessionId, document))
      .catch(() => {})
  }, [sessionId])
  const edit = useCallback((source: string) => send({ type: "EDIT", source }), [send])
  const save = useCallback(() => send({ type: "SAVE_NOW" }), [send])
  const retry = useCallback(() => send({ type: "RETRY" }), [send])
  const keepLocal = useCallback(() => send({ type: "KEEP_LOCAL" }), [send])
  const acceptRemote = useCallback(() => send({ type: "ACCEPT_REMOTE" }), [send])
  const setCriterion = useCallback(
    (criterionId: string, status: PlanAcceptanceStatus, evidence: string | null = null) => {
      const source = updatePlanCriterionSource(
        snapshot.context.draft,
        criterionId,
        status,
        evidence
      )
      if (source !== null) send({ type: "EDIT", source })
    },
    [send, snapshot.context.draft]
  )
  const annotate = useCallback(
    (stageId: string | null, body: string) =>
      send({
        type: "EDIT",
        source: appendPlanAnnotationSource(snapshot.context.draft, {
          id: `annotation-${crypto.randomUUID()}`,
          stageId,
          body,
          author: "user",
          createdAt: new Date().toISOString()
        })
      }),
    [send, snapshot.context.draft]
  )
  const state: PlanEditorSyncState =
    snapshot.matches("loading")
      ? "loading"
      : snapshot.matches("editing")
        ? "editing"
        : snapshot.matches("saving")
          ? "saving"
          : snapshot.matches("conflict")
            ? "conflict"
            : snapshot.matches("error")
              ? "error"
              : "clean"

  return {
    document: snapshot.context.document,
    draft: snapshot.context.draft,
    remote: snapshot.context.remote,
    error: snapshot.context.error,
    state,
    edit,
    save,
    retry,
    keepLocal,
    acceptRemote,
    setCriterion,
    annotate,
    startDraft,
    synced: snapshot.matches("clean"),
    canApprove: snapshot.matches("clean") && snapshot.context.document !== null
  }
}
