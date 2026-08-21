import {
  stableContentHash,
  type MemoryKnowledgeScope,
  type MemoryObservation
} from "@jingler/memory"

export interface ObservationEvidence {
  readonly scope: MemoryKnowledgeScope
  readonly key: string
  readonly text: string
  readonly evidenceId: string
  readonly confidence: number
  readonly createdAt: string
}

const sameScope = (
  left: MemoryKnowledgeScope,
  right: MemoryKnowledgeScope
): boolean => left.kind === right.kind && left.id === right.id

/**
 * Refine one scoped observation while preserving immutable evidence and version
 * history. Evidence from another scope is rejected rather than silently merged.
 */
export const consolidateObservation = (
  history: ReadonlyArray<MemoryObservation>,
  evidence: ObservationEvidence
): MemoryObservation => {
  const previous = [...history]
    .filter((candidate) =>
      candidate.key === evidence.key && sameScope(candidate.scope, evidence.scope)
    )
    .sort((left, right) => right.version - left.version)[0]
  if (previous?.evidenceIds.includes(evidence.evidenceId) === true) return previous
  const evidenceIds = [...new Set([
    ...(previous?.evidenceIds ?? []),
    evidence.evidenceId
  ])].sort()
  const version = (previous?.version ?? 0) + 1
  const identity = stableContentHash([
    evidence.scope.kind,
    evidence.scope.id,
    evidence.key,
    String(version),
    ...evidenceIds
  ].join("\u0000"))
  return {
    id: `observation:${identity}`,
    key: evidence.key,
    scope: evidence.scope,
    text: evidence.text.trim(),
    evidenceIds,
    version,
    ...(previous === undefined ? {} : { supersedesId: previous.id }),
    confidence: Math.max(
      previous?.confidence ?? 0,
      Math.min(1, Math.max(0, evidence.confidence))
    ),
    createdAt: evidence.createdAt
  }
}

export const currentObservations = (
  history: ReadonlyArray<MemoryObservation>,
  scope: MemoryKnowledgeScope
): ReadonlyArray<MemoryObservation> => {
  const latest = new Map<string, MemoryObservation>()
  for (const observation of history) {
    if (!sameScope(observation.scope, scope)) continue
    const previous = latest.get(observation.key)
    if (previous === undefined || observation.version > previous.version) {
      latest.set(observation.key, observation)
    }
  }
  return [...latest.values()].sort((left, right) => left.key.localeCompare(right.key))
}
