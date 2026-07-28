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
const pollers = new Map<
  string,
  { timer: ReturnType<typeof setTimeout> | null; stopped: boolean }
>()

const publish = (sessionId: string, document: PlanDocument): void => {
  for (const listener of listeners.get(sessionId) ?? []) listener(document)
}

const schedulePoll = (
  sessionId: string,
  poller: { timer: ReturnType<typeof setTimeout> | null; stopped: boolean },
  delay: number
): void => {
  poller.timer = setTimeout(() => {
    void rpc
      .planCurrent(sessionId)
      .then((document) => {
        if (poller.stopped) return
        if (document !== null) publish(sessionId, document)
        schedulePoll(sessionId, poller, document === null ? 5000 : 2000)
      })
      .catch(() => {
        if (!poller.stopped) schedulePoll(sessionId, poller, 5000)
      })
  }, delay)
}

const subscribe = (
  sessionId: string,
  listener: (document: PlanDocument) => void
): (() => void) => {
  const existing = listeners.get(sessionId) ?? new Set()
  existing.add(listener)
  listeners.set(sessionId, existing)
  if (!pollers.has(sessionId)) {
    const poller = { timer: null, stopped: false }
    pollers.set(sessionId, poller)
    schedulePoll(sessionId, poller, 1500)
  }
  return () => {
    existing.delete(listener)
    if (existing.size > 0) return
    listeners.delete(sessionId)
    const poller = pollers.get(sessionId)
    if (poller !== undefined) {
      poller.stopped = true
      if (poller.timer !== null) clearTimeout(poller.timer)
      pollers.delete(sessionId)
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
    synced: snapshot.matches("clean"),
    canApprove: snapshot.matches("clean") && snapshot.context.document !== null
  }
}
