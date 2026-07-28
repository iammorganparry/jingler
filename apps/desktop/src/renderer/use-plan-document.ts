import type { PlanAcceptanceStatus, PlanDocument } from "@jingler/core"
import type { PlanEditorSyncState } from "@jingler/ui"
import { useMachine } from "@xstate/react"
import { useCallback } from "react"
import { planDocumentMachine } from "./plan-document-machine.js"
import { rpc } from "./rpc-client.js"

const listeners = new Map<string, Set<(document: PlanDocument) => void>>()

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
  return () => {
    existing.delete(listener)
    if (existing.size === 0) listeners.delete(sessionId)
  }
}

const escapedId = (id: string): string => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const xmlAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
const xmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")

export const updateCriterionSource = (
  source: string,
  criterionId: string,
  status: PlanAcceptanceStatus,
  evidence: string | null
): string => {
  const opening = new RegExp(
    `<Acceptance\\b(?=[^>]*\\bid="${escapedId(criterionId)}")[^>]*>`
  )
  return source.replace(opening, (tag) => {
    const clean = tag
      .replace(/\sstatus="[^"]*"/, "")
      .replace(/\sevidence="[^"]*"/, "")
    const proof = evidence === null ? "" : ` evidence="${xmlAttribute(evidence)}"`
    return `${clean.slice(0, -1)} status="${status}"${proof}>`
  })
}

export const appendAnnotationSource = (
  source: string,
  stageId: string | null,
  body: string
): string => {
  const id = `annotation-${crypto.randomUUID()}`
  const component = `<Annotation id="${id}"${stageId === null ? "" : ` stageId="${xmlAttribute(stageId)}"`} author="user" status="open" createdAt="${new Date().toISOString()}">
${xmlText(body)}
</Annotation>`
  return `${source.trimEnd()}\n\n${component}\n`
}

export function usePlanDocument(sessionId: string) {
  const [snapshot, send] = useMachine(planDocumentMachine, {
    input: {
      sessionId,
      load: () => rpc.planCurrent(sessionId),
      save: async ({ document, source }) => {
        const saved = await rpc.planUpdateDocument({
          sessionId,
          planId: document.id,
          baseRevision: document.revision,
          source,
          author: "user"
        })
        // Let this machine consume its save result before peers receive the
        // broadcast; otherwise its own revision looks like a remote collision.
        setTimeout(() => publish(sessionId, saved), 0)
        return saved
      },
      subscribe: (listener) => {
        const unsubscribe = subscribe(sessionId, listener)
        const timer = setInterval(() => {
          void rpc.planCurrent(sessionId).then((document) => {
            if (document !== null) listener(document)
          }).catch(() => {})
        }, 1000)
        return () => {
          clearInterval(timer)
          unsubscribe()
        }
      }
    }
  })

  const edit = useCallback((source: string) => send({ type: "EDIT", source }), [send])
  const save = useCallback(() => send({ type: "SAVE_NOW" }), [send])
  const retry = useCallback(() => send({ type: "RETRY" }), [send])
  const keepLocal = useCallback(() => send({ type: "KEEP_LOCAL" }), [send])
  const acceptRemote = useCallback(() => send({ type: "ACCEPT_REMOTE" }), [send])
  const setCriterion = useCallback(
    (criterionId: string, status: PlanAcceptanceStatus, evidence: string | null = null) =>
      send({
        type: "EDIT",
        source: updateCriterionSource(snapshot.context.draft, criterionId, status, evidence)
      }),
    [send, snapshot.context.draft]
  )
  const annotate = useCallback(
    (stageId: string | null, body: string) =>
      send({
        type: "EDIT",
        source: appendAnnotationSource(snapshot.context.draft, stageId, body)
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
