import {
  stableContentHash,
  type MemoryKnowledgeScope,
  type MemoryMentalModel,
  type MemoryMentalModelRevision,
  type MemoryObservation
} from "@jingler/memory"

const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu

const sameScope = (
  left: MemoryKnowledgeScope,
  right: MemoryKnowledgeScope
): boolean => left.kind === right.kind && left.id === right.id

const queryTerms = (query: string): ReadonlyArray<string> =>
  [...new Set((query.toLocaleLowerCase("en-US").match(WORD_PATTERN) ?? []))]

export interface MentalModelDefinitionInput {
  readonly id: string
  readonly name: string
  readonly scope: MemoryKnowledgeScope
  readonly sourceQuery: string
  readonly maxTokens: number
  readonly refreshAfterConsolidation: boolean
  readonly publication: MemoryMentalModel["publication"]
  readonly createdAt: string
}

export const defineMentalModel = (
  input: MentalModelDefinitionInput,
  previous?: MemoryMentalModel
): MemoryMentalModel => ({
  ...input,
  maxTokens: Math.max(1, Math.min(32_000, Math.floor(input.maxTokens))),
  definitionVersion: (previous?.definitionVersion ?? 0) + 1
})

/** Build a bounded, evidence-linked model revision from same-scope observations. */
export const refreshMentalModel = (
  definition: MemoryMentalModel,
  observations: ReadonlyArray<MemoryObservation>,
  history: ReadonlyArray<MemoryMentalModelRevision>,
  createdAt: string
): MemoryMentalModelRevision => {
  const terms = queryTerms(definition.sourceQuery)
  const scoped = observations.filter((observation) =>
    sameScope(observation.scope, definition.scope)
  )
  const relevant = scoped.filter((observation) => {
    if (terms.length === 0) return true
    const text = `${observation.key} ${observation.text}`.toLocaleLowerCase("en-US")
    return terms.some((term) => text.includes(term))
  })
  const selected = relevant.length === 0 ? scoped : relevant
  const maxCharacters = definition.maxTokens * 4
  let content = selected
    .map((observation) => `- ${observation.text}`)
    .join("\n")
  if (content.length > maxCharacters) content = content.slice(0, maxCharacters)
  const version = history
    .filter((revision) => revision.modelId === definition.id)
    .reduce((maximum, revision) => Math.max(maximum, revision.version), 0) + 1
  return {
    id: `mental-model-revision:${stableContentHash([
      definition.id,
      String(version),
      ...selected.map((observation) => observation.id)
    ].join("\u0000"))}`,
    modelId: definition.id,
    version,
    content,
    evidenceObservationIds: selected.map((observation) => observation.id).sort(),
    createdAt
  }
}
