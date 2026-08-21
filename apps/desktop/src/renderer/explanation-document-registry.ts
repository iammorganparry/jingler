import { createActor, type ActorRefFrom } from "xstate"
import {
  explanationDocumentMachine,
  type ExplanationDocumentInput
} from "./explanation-document-machine.js"
import { lruKeysToEvict } from "./registry-eviction.js"

export type ExplanationDocumentActor = ActorRefFrom<typeof explanationDocumentMachine>
const actors = new Map<string, ExplanationDocumentActor>()
const mounts = new Map<string, number>()
export const MAX_EXPLANATION_DOCUMENT_ACTORS = 6

const evict = (keep: string): void => {
  const candidates = [...actors.keys()].map((key) => ({
    key,
    pinned: (mounts.get(key) ?? 0) > 0
  }))
  for (const key of lruKeysToEvict(candidates, { keep, max: MAX_EXPLANATION_DOCUMENT_ACTORS })) {
    const actor = actors.get(key)
    if (!actor) continue
    actors.delete(key)
    actor.stop()
  }
}

export const getExplanationDocumentActor = (
  sessionId: string,
  input: ExplanationDocumentInput
): ExplanationDocumentActor => {
  const existing = actors.get(sessionId)
  if (existing) {
    actors.delete(sessionId)
    actors.set(sessionId, existing)
    return existing
  }
  const actor = createActor(explanationDocumentMachine, { input })
  actor.start()
  actors.set(sessionId, actor)
  evict(sessionId)
  return actor
}

export const retainExplanationDocumentActor = (sessionId: string): void => {
  mounts.set(sessionId, (mounts.get(sessionId) ?? 0) + 1)
}

export const releaseExplanationDocumentActor = (sessionId: string): void => {
  const next = (mounts.get(sessionId) ?? 0) - 1
  if (next <= 0) mounts.delete(sessionId)
  else mounts.set(sessionId, next)
}

export const stopExplanationDocument = (sessionId: string): void => {
  mounts.delete(sessionId)
  const actor = actors.get(sessionId)
  if (!actor) return
  actors.delete(sessionId)
  actor.stop()
}
