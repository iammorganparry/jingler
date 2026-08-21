import type { ExplanationDocument } from "@jingler/core"
import { useSelector } from "@xstate/react"
import { useCallback, useEffect, useMemo } from "react"
import {
  getExplanationDocumentActor,
  releaseExplanationDocumentActor,
  retainExplanationDocumentActor
} from "./explanation-document-registry.js"
import { rpc } from "./rpc-client.js"

const listeners = new Map<string, Set<(document: ExplanationDocument | null) => void>>()
const watchers = new Map<string, () => void>()

const publish = (sessionId: string, document: ExplanationDocument | null): void => {
  for (const listener of listeners.get(sessionId) ?? []) listener(document)
}

const subscribe = (
  sessionId: string,
  listener: (document: ExplanationDocument | null) => void
): (() => void) => {
  const current = listeners.get(sessionId) ?? new Set()
  current.add(listener)
  listeners.set(sessionId, current)
  if (!watchers.has(sessionId)) {
    watchers.set(sessionId, rpc.explanationWatch(sessionId, (document) => publish(sessionId, document)))
  }
  return () => {
    current.delete(listener)
    if (current.size > 0) return
    listeners.delete(sessionId)
    watchers.get(sessionId)?.()
    watchers.delete(sessionId)
  }
}

export function useExplanationDocument(sessionId: string) {
  const actor = useMemo(
    () => getExplanationDocumentActor(sessionId, {
      sessionId,
      load: () => rpc.explanationCurrent(sessionId),
      subscribe: (listener) => subscribe(sessionId, listener)
    }),
    [sessionId]
  )
  useEffect(() => {
    retainExplanationDocumentActor(sessionId)
    return () => releaseExplanationDocumentActor(sessionId)
  }, [sessionId])
  const snapshot = useSelector(
    actor,
    (state) => state,
    (left, right) => left === right || (left.context === right.context && left.value === right.value)
  )
  return {
    document: snapshot.context.document,
    error: snapshot.context.error,
    loading: snapshot.matches("loading"),
    retry: useCallback(() => actor.send({ type: "RETRY" }), [actor])
  }
}
